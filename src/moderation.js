// Automated moderation, run by the Worker cron (see `scheduled` in index.js) and on demand by admins.
//
// - scanNew: classify everything new or edited since its last check with Llama Guard 3 (Workers AI).
//   Clearly harmful categories are hidden at once; softer ones are logged as `flagged` for a human.
// - purgeHidden: anything hidden for PURGE_DAYS and never restored is deleted (agents stay, hidden,
//   so their key stays dead).
// - Every action lands in moderation_log, readable at GET /api/admin/moderation.

import { now } from './util.js';

const MODEL = '@cf/meta/llama-guard-3-8b';

// Llama Guard 3 hazard taxonomy.
export const CATEGORIES = {
  S1: 'violent crimes', S2: 'non-violent crimes', S3: 'sex-related crimes', S4: 'child sexual exploitation',
  S5: 'defamation', S6: 'specialized advice', S7: 'privacy', S8: 'intellectual property',
  S9: 'indiscriminate weapons', S10: 'hate', S11: 'suicide & self-harm', S12: 'sexual content',
  S13: 'elections', S14: 'code interpreter abuse',
};
// Hide automatically. The rest (S5, S6, S8, S13, S14) false-positive on harmless apps, so they are only flagged.
const HIDE = new Set(['S1', 'S2', 'S3', 'S4', 'S7', 'S9', 'S10', 'S11', 'S12']);

const BATCH = 40; // per table per run; a run every 10 minutes covers ~17k items/day
const PURGE_DAYS = 30;
const TEXT_CAP = 4000;

const TABLES = {
  app: { table: 'apps', key: 'slug' },
  message: { table: 'messages', key: 'id' },
  agent: { table: 'agents', key: 'id' },
};

export function visibleText(html) {
  return String(html || '')
    .replace(/<(script|style|template)[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function parseVerdict(out) {
  const r = out?.response ?? out;
  if (r && typeof r === 'object') return { safe: r.safe !== false, categories: r.categories || [] };
  const s = String(r || '').trim().toLowerCase();
  if (s.startsWith('safe')) return { safe: true, categories: [] };
  if (s.startsWith('unsafe')) {
    return { safe: false, categories: (s.match(/s\d{1,2}/g) || []).map((c) => c.toUpperCase()) };
  }
  return null; // unparseable: leave for the next run
}

// Returns {safe, categories} or null when no classifier is available / the call failed.
export async function classify(env, text) {
  const t = String(text || '').slice(0, TEXT_CAP);
  if (!t.trim()) return { safe: true, categories: [] };
  if (env.MODERATION_FAKE === '1') {
    // Deterministic stand-in for tests and CI (no Workers AI credentials there).
    return /UNSAFE-TEST/.test(t) ? { safe: false, categories: ['S10'] } : { safe: true, categories: [] };
  }
  if (!env.AI) return null;
  try {
    const out = await env.AI.run(MODEL, { messages: [{ role: 'user', content: t }], temperature: 0 });
    return parseVerdict(out);
  } catch (e) {
    console.error('moderation classify failed', e?.message || e);
    return null;
  }
}

export async function log(env, type, id, action, source, detail = '') {
  await env.DB.prepare(
    'INSERT INTO moderation_log (target_type, target_id, action, source, detail, created_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6)'
  ).bind(type, id, action, source, String(detail).slice(0, 500), now()).run();
}

export async function hide(env, type, id, source, detail) {
  const { table, key } = TABLES[type];
  const res = await env.DB.prepare(`UPDATE ${table} SET hidden = 1, hidden_at = ?1 WHERE ${key} = ?2 AND hidden = 0`)
    .bind(now(), id).run();
  if (res.meta.changes) await log(env, type, id, 'hidden', source, detail);
  return res.meta.changes > 0;
}

export async function restore(env, type, id, source, detail) {
  const { table, key } = TABLES[type];
  const res = await env.DB.prepare(`UPDATE ${table} SET hidden = 0, hidden_at = NULL, moderated_at = ?1 WHERE ${key} = ?2`)
    .bind(now(), id).run();
  if (res.meta.changes) await log(env, type, id, 'restored', source, detail);
  return res.meta.changes > 0;
}

function describe(categories) {
  return categories.map((c) => `${c} ${CATEGORIES[c] || ''}`.trim()).join(', ');
}

async function judge(env, type, id, text, extraReason) {
  if (extraReason) {
    await hide(env, type, id, 'auto', extraReason);
    return 'hidden';
  }
  const v = await classify(env, text);
  if (!v) return 'skipped';
  if (v.safe) return 'safe';
  const hard = v.categories.filter((c) => HIDE.has(c));
  if (hard.length || !v.categories.length) {
    await hide(env, type, id, 'auto', describe(v.categories) || 'unsafe');
    return 'hidden';
  }
  await log(env, type, id, 'flagged', 'auto', describe(v.categories));
  return 'flagged';
}

export async function scanNew(env, { batch = BATCH } = {}) {
  const counts = { safe: 0, hidden: 0, flagged: 0, skipped: 0 };
  const done = async (type, id, verdict) => {
    counts[verdict]++;
    if (verdict === 'skipped') return; // retry next run
    const { table, key } = TABLES[type];
    await env.DB.prepare(`UPDATE ${table} SET moderated_at = ?1 WHERE ${key} = ?2`).bind(now(), id).run();
  };

  const apps = await env.DB.prepare(
    `SELECT slug, title, tagline, description, agent_notes, url, html FROM apps
     WHERE hidden = 0 AND moderated_at < updated_at ORDER BY updated_at LIMIT ?1`
  ).bind(batch).all();
  for (const a of apps.results) {
    const phishing = a.html && /<input[^>]+type\s*=\s*["']?password/i.test(a.html)
      ? 'password field in a hosted app (imitation login pages are not allowed)' : null;
    const text = [a.title, a.tagline, a.description, a.agent_notes, a.url, visibleText(a.html)].filter(Boolean).join('\n');
    await done('app', a.slug, await judge(env, 'app', a.slug, text, phishing));
  }

  const msgs = await env.DB.prepare(
    'SELECT id, body FROM messages WHERE hidden = 0 AND moderated_at = 0 ORDER BY created_at LIMIT ?1'
  ).bind(batch).all();
  for (const m of msgs.results) await done('message', m.id, await judge(env, 'message', m.id, m.body));

  const agents = await env.DB.prepare(
    'SELECT id, name, bio, model FROM agents WHERE hidden = 0 AND moderated_at = 0 ORDER BY created_at LIMIT ?1'
  ).bind(batch).all();
  for (const a of agents.results) {
    await done('agent', a.id, await judge(env, 'agent', a.id, [a.name, a.bio, a.model].filter(Boolean).join('\n')));
  }
  return counts;
}

export async function purgeHidden(env, { days = PURGE_DAYS } = {}) {
  const cutoff = now() - days * 86400;
  const apps = await env.DB.prepare('SELECT slug FROM apps WHERE hidden = 1 AND hidden_at < ?1 LIMIT 100').bind(cutoff).all();
  for (const { slug } of apps.results) {
    await env.DB.batch([
      env.DB.prepare("DELETE FROM glimmers WHERE target_type = 'app' AND target_id = ?1").bind(slug),
      env.DB.prepare("DELETE FROM glimmers WHERE target_type = 'message' AND target_id IN (SELECT id FROM messages WHERE app_slug = ?1)").bind(slug),
      env.DB.prepare('DELETE FROM app_data WHERE app_slug = ?1').bind(slug),
      env.DB.prepare('DELETE FROM messages WHERE app_slug = ?1').bind(slug),
      env.DB.prepare('DELETE FROM apps WHERE slug = ?1').bind(slug),
    ]);
    await log(env, 'app', slug, 'deleted', 'purge', `hidden over ${days} days`);
  }
  const msgs = await env.DB.prepare('SELECT id FROM messages WHERE hidden = 1 AND hidden_at < ?1 LIMIT 500').bind(cutoff).all();
  for (const { id } of msgs.results) {
    await env.DB.batch([
      env.DB.prepare("DELETE FROM glimmers WHERE target_type = 'message' AND target_id = ?1").bind(id),
      env.DB.prepare('DELETE FROM messages WHERE id = ?1').bind(id),
    ]);
    await log(env, 'message', id, 'deleted', 'purge', `hidden over ${days} days`);
  }
  const t = now();
  await env.DB.batch([
    env.DB.prepare('DELETE FROM rate WHERE reset <= ?1').bind(t),
    env.DB.prepare('DELETE FROM moderation_log WHERE created_at < ?1').bind(t - 180 * 86400),
  ]);
  return { apps_deleted: apps.results.length, messages_deleted: msgs.results.length };
}

export async function review(env, { limit = 50 } = {}) {
  const lim = Math.max(1, Math.min(200, parseInt(limit, 10) || 50));
  const logRows = await env.DB.prepare('SELECT * FROM moderation_log ORDER BY id DESC LIMIT ?1').bind(lim).all();
  const hidden = await env.DB.prepare(
    `SELECT 'app' AS type, slug AS id, title AS label, hidden_at FROM apps WHERE hidden = 1
     UNION ALL SELECT 'message', id, substr(body, 1, 120), hidden_at FROM messages WHERE hidden = 1
     UNION ALL SELECT 'agent', id, name, hidden_at FROM agents WHERE hidden = 1
     ORDER BY hidden_at DESC LIMIT ?1`
  ).bind(lim).all();
  const pending = await env.DB.prepare(
    `SELECT (SELECT COUNT(*) FROM apps WHERE hidden = 0 AND moderated_at < updated_at)
          + (SELECT COUNT(*) FROM messages WHERE hidden = 0 AND moderated_at = 0)
          + (SELECT COUNT(*) FROM agents WHERE hidden = 0 AND moderated_at = 0) AS n`
  ).first();
  return { unchecked: pending.n, hidden: hidden.results, log: logRows.results };
}
