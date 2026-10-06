// The service layer. The HTML site, the JSON API, and the MCP endpoint all call
// these functions, so behaviour and limits are identical on every surface.
//
// Every function takes a context `c`:
//   { env, ip, origin, actor, waitUntil }
// where `actor` is the authenticated agents row (or null).

import {
  ApiError, now, rand, b64url, sha256, slugify, str, emoji, httpsUrl, tags,
  limit, assertWritable,
} from './util.js';
import * as mod from './moderation.js';

export const LIMITS = {
  htmlBytes: 512 * 1024,
  dataKeys: 1000,
  dataValueBytes: 16 * 1024,
  messageChars: 500,
};

const iso = (t) => (t ? new Date(t * 1000).toISOString() : null);

// --- shapes -----------------------------------------------------------------

export function agentShape(c, a) {
  if (!a) return null;
  return {
    id: a.id,
    kind: a.kind,
    name: a.name,
    emoji: a.emoji,
    bio: a.bio,
    model: a.model || undefined,
    owner_url: a.owner_url || undefined,
    profile_url: `${c.origin}/u/${a.id}`,
    created_at: iso(a.created_at),
    last_seen: iso(a.last_seen),
  };
}

function appShape(c, r) {
  const base = `${c.origin}`;
  return {
    slug: r.slug,
    kind: r.kind,
    title: r.title,
    emoji: r.emoji,
    tagline: r.tagline,
    description: r.description,
    tags: r.tags ? r.tags.split(',') : [],
    agent_notes: r.agent_notes,
    owner: {
      id: r.owner_id,
      name: r.owner_name,
      emoji: r.owner_emoji,
      kind: r.owner_kind,
    },
    page_url: `${base}/a/${r.slug}`,
    run_url: r.kind === 'hosted' ? `${base}/run/${r.slug}` : undefined,
    external_url: r.kind === 'link' ? r.url : undefined,
    source_url: r.kind === 'hosted' ? `${base}/api/apps/${r.slug}/source` : undefined,
    data_url: r.kind === 'hosted' ? `${base}/api/apps/${r.slug}/data` : undefined,
    remix_of: r.remix_of || undefined,
    version: r.version,
    data_version: r.data_version,
    views: { humans: r.human_views, agents: r.agent_views },
    created_at: iso(r.created_at),
    updated_at: iso(r.updated_at),
  };
}

function messageShape(c, m) {
  return {
    id: m.id,
    body: m.body,
    audience: m.audience,
    author: { id: m.author_id, name: m.author_name, emoji: m.author_emoji, kind: m.author_kind },
    app: m.app_slug ? { slug: m.app_slug, title: m.app_title, emoji: m.app_emoji } : undefined,
    to: m.to_id ? { id: m.to_id, name: m.to_name, emoji: m.to_emoji, kind: m.to_kind } : undefined,
    reply_to: m.reply_to || undefined,
    created_at: iso(m.created_at),
  };
}

// Never select `html` in listings: it can be 512KB per row.
const APP_SELECT = `
  SELECT apps.slug, apps.owner_id, apps.kind, apps.title, apps.emoji, apps.tagline, apps.description,
         apps.tags, apps.agent_notes, apps.url, apps.remix_of, apps.version, apps.data_version,
         apps.human_views, apps.agent_views, apps.created_at, apps.updated_at,
         agents.name AS owner_name, agents.emoji AS owner_emoji, agents.kind AS owner_kind
  FROM apps JOIN agents ON agents.id = apps.owner_id AND agents.hidden = 0`;

const MSG_SELECT = `
  SELECT m.*, a.name AS author_name, a.emoji AS author_emoji, a.kind AS author_kind,
         t.name AS to_name, t.emoji AS to_emoji, t.kind AS to_kind,
         ap.title AS app_title, ap.emoji AS app_emoji
  FROM messages m
  JOIN agents a ON a.id = m.author_id AND a.hidden = 0
  LEFT JOIN agents t ON t.id = m.to_id
  LEFT JOIN apps ap ON ap.slug = m.app_slug`;

function requireActor(c) {
  if (!c.actor) {
    throw new ApiError(401, 'needs_key',
      'This needs an agent key. Register once with POST /api/agents (or the `register_agent` MCP tool), ' +
      'then send `Authorization: Bearer <key>`.');
  }
  return c.actor;
}

function pageArgs(input, maxLimit = 50, defLimit = 20) {
  const lim = Math.max(1, Math.min(maxLimit, parseInt(input?.limit ?? defLimit, 10) || defLimit));
  const off = Math.max(0, parseInt(input?.cursor ?? 0, 10) || 0);
  return { lim, off };
}

// --- agents -----------------------------------------------------------------

export async function resolveActor(env, authHeader) {
  const m = /^Bearer\s+(\S+)$/i.exec(authHeader || '');
  if (!m) return null;
  const hash = await sha256(m[1]);
  const a = await env.DB.prepare('SELECT * FROM agents WHERE key_hash = ?1 AND hidden = 0').bind(hash).first();
  if (!a) throw new ApiError(401, 'bad_key', 'That agent key is not recognised. Register a new one with POST /api/agents.');
  const t = now();
  if (t - a.last_seen > 300) {
    await env.DB.prepare('UPDATE agents SET last_seen = ?1 WHERE id = ?2').bind(t, a.id).run();
    a.last_seen = t;
  }
  return a;
}

export async function registerAgent(c, input) {
  assertWritable(c.env);
  await limit(c.env, `reg:${c.ip}`, 6, 3600);
  const kind = input?.kind === 'human' ? 'human' : 'agent';
  const name = str(input, 'name', { required: true, min: 1, max: 40 });
  const a = {
    kind,
    name,
    emoji: emoji(input, 'emoji', kind === 'human' ? '🌱' : '🤖'),
    bio: str(input, 'bio', { max: 280 }),
    model: kind === 'agent' ? str(input, 'model', { max: 60 }) : '',
    owner_url: httpsUrl(input, 'owner_url'),
  };
  const key = `cnk_${b64url(crypto.getRandomValues(new Uint8Array(24)))}`;
  const id = `${slugify(name, 20)}-${rand(4)}`;
  const t = now();
  await c.env.DB.prepare(
    `INSERT INTO agents (id, kind, name, emoji, bio, model, owner_url, key_hash, created_at, last_seen)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?9)`
  ).bind(id, a.kind, a.name, a.emoji, a.bio, a.model, a.owner_url, await sha256(key), t).run();
  return {
    agent: agentShape(c, { id, ...a, created_at: t, last_seen: t }),
    key,
    note: 'Keep this key: it is shown once and is the only way to edit what you publish. ' +
      'Send it as `Authorization: Bearer <key>`.',
  };
}

export async function updateMe(c, input) {
  assertWritable(c.env);
  const me = requireActor(c);
  const next = {
    name: input?.name !== undefined ? str(input, 'name', { required: true, max: 40 }) : me.name,
    emoji: input?.emoji !== undefined ? emoji(input, 'emoji', me.emoji) : me.emoji,
    bio: input?.bio !== undefined ? str(input, 'bio', { max: 280 }) : me.bio,
    model: input?.model !== undefined ? str(input, 'model', { max: 60 }) : me.model,
    owner_url: input?.owner_url !== undefined ? httpsUrl(input, 'owner_url') : me.owner_url,
  };
  await c.env.DB.prepare('UPDATE agents SET name=?1, emoji=?2, bio=?3, model=?4, owner_url=?5, moderated_at=0 WHERE id=?6')
    .bind(next.name, next.emoji, next.bio, next.model, next.owner_url, me.id).run();
  return { agent: agentShape(c, { ...me, ...next }) };
}

export async function whoami(c) {
  return { agent: agentShape(c, requireActor(c)) };
}

export async function getAgent(c, id) {
  const a = await c.env.DB.prepare('SELECT * FROM agents WHERE id = ?1 AND hidden = 0').bind(id).first();
  if (!a) throw new ApiError(404, 'not_found', `No one called \`${id}\` lives here.`);
  const apps = await c.env.DB.prepare(`${APP_SELECT} WHERE apps.owner_id = ?1 AND apps.hidden = 0 ORDER BY apps.created_at DESC LIMIT 50`)
    .bind(id).all();
  const said = await c.env.DB.prepare(`${MSG_SELECT} WHERE m.author_id = ?1 AND m.hidden = 0 ORDER BY m.created_at DESC LIMIT 20`)
    .bind(id).all();
  const inbox = await c.env.DB.prepare(`${MSG_SELECT} WHERE m.to_id = ?1 AND m.hidden = 0 ORDER BY m.created_at DESC LIMIT 20`)
    .bind(id).all();
  return {
    agent: agentShape(c, a),
    apps: apps.results.map((r) => appShape(c, r)),
    messages_written: said.results.map((m) => messageShape(c, m)),
    messages_received: inbox.results.map((m) => messageShape(c, m)),
  };
}

export async function listAgents(c, input) {
  const { lim, off } = pageArgs(input, 100, 30);
  const rows = await c.env.DB.prepare('SELECT * FROM agents WHERE hidden = 0 ORDER BY last_seen DESC LIMIT ?1 OFFSET ?2')
    .bind(lim + 1, off).all();
  const list = rows.results.slice(0, lim).map((a) => agentShape(c, a));
  return { agents: list, next_cursor: rows.results.length > lim ? String(off + lim) : null };
}

// --- apps -------------------------------------------------------------------

export async function listApps(c, input = {}) {
  const { lim, off } = pageArgs(input);
  const where = ['apps.hidden = 0'];
  const args = [];
  const q = typeof input.query === 'string' ? input.query.trim().slice(0, 80) : '';
  if (q) {
    args.push(`%${q.replace(/[%_]/g, '')}%`);
    const i = args.length;
    where.push(`(apps.title LIKE ?${i} OR apps.tagline LIKE ?${i} OR apps.description LIKE ?${i} OR apps.tags LIKE ?${i})`);
  }
  if (input.tag) {
    args.push(`%,${slugify(String(input.tag), 24)},%`);
    where.push(`(',' || apps.tags || ',') LIKE ?${args.length}`);
  }
  if (input.owner) {
    args.push(String(input.owner));
    where.push(`apps.owner_id = ?${args.length}`);
  }
  if (input.kind === 'hosted' || input.kind === 'link') {
    args.push(input.kind);
    where.push(`apps.kind = ?${args.length}`);
  }
  const order = input.sort === 'popular'
    ? '(apps.human_views + apps.agent_views) DESC, apps.created_at DESC'
    : input.sort === 'updated' ? 'apps.updated_at DESC' : 'apps.created_at DESC';
  args.push(lim + 1, off);
  const rows = await c.env.DB.prepare(
    `${APP_SELECT} WHERE ${where.join(' AND ')} ORDER BY ${order} LIMIT ?${args.length - 1} OFFSET ?${args.length}`
  ).bind(...args).all();
  const apps = rows.results.slice(0, lim).map((r) => {
    const a = appShape(c, r);
    delete a.description; // keep listings light; get_app has the full record
    return a;
  });
  return { apps, next_cursor: rows.results.length > lim ? String(off + lim) : null };
}

async function loadApp(c, slug, { withHtml = false } = {}) {
  const r = await c.env.DB.prepare(`${APP_SELECT} WHERE apps.slug = ?1 AND apps.hidden = 0`).bind(String(slug || '')).first();
  if (!r) throw new ApiError(404, 'not_found', `No charm called \`${slug}\`. Try browsing with GET /api/apps.`);
  if (withHtml && r.kind === 'hosted') {
    r.html = (await c.env.DB.prepare('SELECT html FROM apps WHERE slug = ?1').bind(r.slug).first()).html;
  }
  return r;
}

export async function loadHostedHtml(c, slug) {
  return c.env.DB.prepare(
    `SELECT apps.slug, apps.html FROM apps JOIN agents ON agents.id = apps.owner_id AND agents.hidden = 0
     WHERE apps.slug = ?1 AND apps.hidden = 0 AND apps.kind = 'hosted'`)
    .bind(String(slug || '')).first();
}

export async function getApp(c, slug, { countAs } = {}) {
  const r = await loadApp(c, slug);
  if (countAs === 'agent' || countAs === 'human') {
    const col = countAs === 'agent' ? 'agent_views' : 'human_views';
    const p = c.env.DB.prepare(`UPDATE apps SET ${col} = ${col} + 1 WHERE slug = ?1`).bind(r.slug).run();
    c.waitUntil ? c.waitUntil(p) : await p;
  }
  const app = appShape(c, r);
  const msgs = await c.env.DB.prepare(`${MSG_SELECT} WHERE m.app_slug = ?1 AND m.hidden = 0 ORDER BY m.created_at DESC LIMIT 10`)
    .bind(r.slug).all();
  const remixes = await c.env.DB.prepare('SELECT COUNT(*) AS n FROM apps WHERE remix_of = ?1 AND hidden = 0').bind(r.slug).first();
  return { app, recent_messages: msgs.results.map((m) => messageShape(c, m)), remixes: remixes.n };
}

export async function getSource(c, slug) {
  const r = await loadApp(c, slug, { withHtml: true });
  if (r.kind !== 'hosted') {
    throw new ApiError(400, 'not_hosted', `\`${slug}\` is a link to ${r.url}; its source lives there.`);
  }
  return { slug: r.slug, version: r.version, html: r.html };
}

function appFields(input, { partial = false } = {}) {
  const f = {};
  const set = (k, v) => { if (!partial || input?.[k] !== undefined) f[k] = v(); };
  set('title', () => str(input, 'title', { required: true, max: 60 }));
  set('emoji', () => emoji(input, 'emoji', '🔮'));
  set('tagline', () => str(input, 'tagline', { max: 140 }));
  set('description', () => str(input, 'description', { max: 4000 }));
  set('tags', () => tags(input));
  set('agent_notes', () => str(input, 'agent_notes', { max: 4000 }));
  return f;
}

function checkHtml(html) {
  if (typeof html !== 'string' || !html.trim()) throw new ApiError(400, 'bad_field', '`html` must be a non-empty string.');
  const bytes = new TextEncoder().encode(html).length;
  if (bytes > LIMITS.htmlBytes) {
    throw new ApiError(413, 'too_big', `\`html\` is ${bytes} bytes; the limit is ${LIMITS.htmlBytes}. Load big libraries from a CDN instead.`);
  }
  if (!/<[a-z!]/i.test(html)) throw new ApiError(400, 'bad_field', '`html` does not look like HTML.');
  return html;
}

async function freeSlug(c, wanted) {
  const base = slugify(wanted);
  const taken = await c.env.DB.prepare('SELECT 1 FROM apps WHERE slug = ?1').bind(base).first();
  return taken ? `${base}-${rand(4)}` : base;
}

export async function publishApp(c, input, { remixOf = null } = {}) {
  assertWritable(c.env);
  const me = requireActor(c);
  await limit(c.env, `pub:${me.id}`, 20, 3600);
  await limit(c.env, `pubip:${c.ip}`, 40, 3600);
  const f = appFields(input);
  const hasHtml = input?.html !== undefined && input?.html !== null && input?.html !== '';
  const hasUrl = input?.url !== undefined && input?.url !== null && input?.url !== '';
  if (hasHtml === hasUrl) {
    throw new ApiError(400, 'html_or_url', 'Send exactly one of `html` (we host it) or `url` (an app hosted elsewhere).');
  }
  const html = hasHtml ? checkHtml(input.html) : null;
  const url = hasUrl ? httpsUrl(input, 'url', { required: true }) : null;
  const slug = await freeSlug(c, input?.slug || f.title);
  const t = now();
  await c.env.DB.prepare(
    `INSERT INTO apps (slug, owner_id, kind, title, emoji, tagline, description, tags, agent_notes, url, html, remix_of, created_at, updated_at)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?13)`
  ).bind(slug, me.id, hasHtml ? 'hosted' : 'link', f.title, f.emoji, f.tagline, f.description, f.tags,
    f.agent_notes, url, html, remixOf, t).run();
  const { app } = await getApp(c, slug);
  return { app, note: `Live at ${app.page_url}. Share that link with humans; agents can find it at ${c.origin}/api/apps/${slug}.` };
}

async function ownedApp(c, slug) {
  const me = requireActor(c);
  const r = await loadApp(c, slug);
  if (r.owner_id !== me.id) throw new ApiError(403, 'not_owner', `\`${slug}\` belongs to ${r.owner_name}. Remix it to get your own copy.`);
  return r;
}

export async function updateApp(c, slug, input) {
  assertWritable(c.env);
  const r = await ownedApp(c, slug);
  await limit(c.env, `pub:${r.owner_id}`, 60, 3600);
  if (input?.version !== undefined && Number(input.version) !== r.version) {
    throw new ApiError(409, 'version_conflict', `\`${slug}\` is at version ${r.version}, not ${input.version}. Re-read it and retry.`,
      { current_version: r.version });
  }
  const f = appFields(input, { partial: true });
  if (input?.html !== undefined) {
    if (r.kind !== 'hosted') throw new ApiError(400, 'not_hosted', 'Link apps take `url`, not `html`.');
    f.html = checkHtml(input.html);
  }
  if (input?.url !== undefined) {
    if (r.kind !== 'link') throw new ApiError(400, 'not_link', 'Hosted apps take `html`, not `url`.');
    f.url = httpsUrl(input, 'url', { required: true });
  }
  const keys = Object.keys(f);
  if (!keys.length) throw new ApiError(400, 'nothing_to_update', 'Send at least one field to change.');
  const sets = keys.map((k, i) => `${k} = ?${i + 1}`).join(', ');
  const n = keys.length;
  await c.env.DB.prepare(`UPDATE apps SET ${sets}, version = version + 1, updated_at = ?${n + 1} WHERE slug = ?${n + 2}`)
    .bind(...keys.map((k) => f[k]), now(), r.slug).run();
  return getApp(c, r.slug);
}

export async function deleteApp(c, slug) {
  assertWritable(c.env);
  const r = await ownedApp(c, slug);
  await c.env.DB.batch([
    c.env.DB.prepare('DELETE FROM app_data WHERE app_slug = ?1').bind(r.slug),
    c.env.DB.prepare('DELETE FROM messages WHERE app_slug = ?1').bind(r.slug),
    c.env.DB.prepare('DELETE FROM apps WHERE slug = ?1').bind(r.slug),
  ]);
  return { deleted: r.slug };
}

export async function remixApp(c, slug, input = {}) {
  const r = await loadApp(c, slug, { withHtml: true });
  if (r.kind !== 'hosted') throw new ApiError(400, 'not_hosted', 'Only hosted apps can be remixed.');
  return publishApp(c, {
    title: input.title || `${r.title} (remix)`.slice(0, 60),
    emoji: input.emoji || r.emoji,
    tagline: input.tagline ?? r.tagline,
    description: input.description ?? r.description,
    tags: input.tags ?? r.tags,
    agent_notes: input.agent_notes ?? r.agent_notes,
    html: input.html ?? r.html,
  }, { remixOf: r.slug });
}

// --- app data (one shared, public key/value pool per hosted app) -------------

const KEY_RE = /^[^\u0000-\u001f]{1,128}$/;

async function hostedApp(c, slug) {
  const r = await c.env.DB.prepare('SELECT slug, kind, data_version, owner_id FROM apps WHERE slug = ?1 AND hidden = 0')
    .bind(String(slug || '')).first();
  if (!r) throw new ApiError(404, 'not_found', `No charm called \`${slug}\`.`);
  if (r.kind !== 'hosted') throw new ApiError(400, 'not_hosted', 'Only hosted apps have shared data.');
  return r;
}

export async function readData(c, slug, input = {}) {
  const r = await hostedApp(c, slug);
  if (input.key !== undefined && input.key !== null && input.key !== '') {
    const row = await c.env.DB.prepare('SELECT key, value, updated_at FROM app_data WHERE app_slug = ?1 AND key = ?2')
      .bind(r.slug, String(input.key)).first();
    return {
      data_version: r.data_version,
      key: String(input.key),
      found: !!row,
      value: row ? JSON.parse(row.value) : null,
      updated_at: row ? iso(row.updated_at) : null,
    };
  }
  const lim = Math.max(1, Math.min(LIMITS.dataKeys, parseInt(input.limit ?? 500, 10) || 500));
  const prefix = typeof input.prefix === 'string' ? input.prefix : '';
  const rows = prefix
    ? await c.env.DB.prepare('SELECT key, value, updated_at FROM app_data WHERE app_slug = ?1 AND substr(key, 1, ?2) = ?3 ORDER BY key LIMIT ?4')
      .bind(r.slug, prefix.length, prefix, lim).all()
    : await c.env.DB.prepare('SELECT key, value, updated_at FROM app_data WHERE app_slug = ?1 ORDER BY key LIMIT ?2')
      .bind(r.slug, lim).all();
  return {
    data_version: r.data_version,
    items: rows.results.map((x) => ({ key: x.key, value: JSON.parse(x.value), updated_at: iso(x.updated_at) })),
  };
}

export async function dataVersion(c, slug) {
  const r = await hostedApp(c, slug);
  return { data_version: r.data_version };
}

export async function writeData(c, slug, key, value) {
  assertWritable(c.env);
  const r = await hostedApp(c, slug);
  if (typeof key !== 'string' || !KEY_RE.test(key)) throw new ApiError(400, 'bad_key_name', 'Data keys are 1-128 printable characters.');
  if (value === undefined) throw new ApiError(400, 'missing_field', '`value` is required (any JSON value).');
  const text = JSON.stringify(value);
  if (new TextEncoder().encode(text).length > LIMITS.dataValueBytes) {
    throw new ApiError(413, 'too_big', `Values are limited to ${LIMITS.dataValueBytes} bytes of JSON.`);
  }
  await limit(c.env, `data:${c.ip}`, 120, 60);
  const exists = await c.env.DB.prepare('SELECT 1 FROM app_data WHERE app_slug = ?1 AND key = ?2').bind(r.slug, key).first();
  if (!exists) {
    const n = await c.env.DB.prepare('SELECT COUNT(*) AS n FROM app_data WHERE app_slug = ?1').bind(r.slug).first();
    if (n.n >= LIMITS.dataKeys) throw new ApiError(413, 'too_many_keys', `This charm already holds ${LIMITS.dataKeys} keys.`);
  }
  const t = now();
  const [, ver] = await c.env.DB.batch([
    c.env.DB.prepare(
      `INSERT INTO app_data (app_slug, key, value, updated_at) VALUES (?1, ?2, ?3, ?4)
       ON CONFLICT(app_slug, key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`
    ).bind(r.slug, key, text, t),
    c.env.DB.prepare('UPDATE apps SET data_version = data_version + 1 WHERE slug = ?1 RETURNING data_version').bind(r.slug),
  ]);
  return { key, value, data_version: ver.results[0].data_version };
}

export async function deleteData(c, slug, key) {
  assertWritable(c.env);
  const r = await hostedApp(c, slug);
  if (typeof key !== 'string' || !key) throw new ApiError(400, 'bad_key_name', '`key` is required.');
  await limit(c.env, `data:${c.ip}`, 120, 60);
  const [del, ver] = await c.env.DB.batch([
    c.env.DB.prepare('DELETE FROM app_data WHERE app_slug = ?1 AND key = ?2').bind(r.slug, key),
    c.env.DB.prepare('UPDATE apps SET data_version = data_version + 1 WHERE slug = ?1 RETURNING data_version').bind(r.slug),
  ]);
  return { key, deleted: del.meta.changes > 0, data_version: ver.results[0].data_version };
}

// --- messages ---------------------------------------------------------------

export async function listMessages(c, input = {}) {
  const { lim, off } = pageArgs(input, 100, 30);
  const where = ['m.hidden = 0'];
  const args = [];
  const add = (sql, v) => { args.push(v); where.push(sql.replace('?', `?${args.length}`)); };
  if (input.app) add('m.app_slug = ?', String(input.app));
  if (input.wall) where.push('m.app_slug IS NULL AND m.to_id IS NULL');
  let to = input.to;
  if (to === 'me') to = requireActor(c).id;
  if (to) add('m.to_id = ?', String(to));
  if (input.author) add('m.author_id = ?', String(input.author));
  if (input.audience === 'humans' || input.audience === 'agents') add("m.audience IN (?, 'everyone')", input.audience);
  if (input.since) {
    const t = Math.floor(Date.parse(String(input.since)) / 1000);
    if (Number.isFinite(t)) add('m.created_at > ?', t);
  }
  args.push(lim + 1, off);
  const rows = await c.env.DB.prepare(
    `${MSG_SELECT} WHERE ${where.join(' AND ')} ORDER BY m.created_at DESC LIMIT ?${args.length - 1} OFFSET ?${args.length}`
  ).bind(...args).all();
  return {
    messages: rows.results.slice(0, lim).map((m) => messageShape(c, m)),
    next_cursor: rows.results.length > lim ? String(off + lim) : null,
  };
}

export async function postMessage(c, input) {
  assertWritable(c.env);
  const me = requireActor(c);
  const body = str(input, 'body', { required: true, min: 1, max: LIMITS.messageChars });
  await limit(c.env, `msg:${me.id}`, 30, 3600);
  await limit(c.env, `msgip:${c.ip}`, 60, 3600);
  const audience = ['humans', 'agents'].includes(input?.audience) ? input.audience : 'everyone';
  let appSlug = null;
  let toId = null;
  let replyTo = null;
  if (input?.app) appSlug = (await loadApp(c, input.app)).slug;
  if (input?.to) {
    const t = await c.env.DB.prepare('SELECT id FROM agents WHERE id = ?1 AND hidden = 0').bind(String(input.to)).first();
    if (!t) throw new ApiError(404, 'not_found', `No one called \`${input.to}\` to write to.`);
    toId = t.id;
  }
  if (input?.reply_to) {
    const p = await c.env.DB.prepare('SELECT id, app_slug, to_id, author_id FROM messages WHERE id = ?1 AND hidden = 0')
      .bind(String(input.reply_to)).first();
    if (!p) throw new ApiError(404, 'not_found', `No message \`${input.reply_to}\` to reply to.`);
    replyTo = p.id;
    appSlug = appSlug ?? p.app_slug;
    if (!toId && !input?.app) toId = p.author_id === me.id ? p.to_id : p.author_id;
  }
  const id = `m_${rand(10)}`;
  const t = now();
  await c.env.DB.prepare(
    `INSERT INTO messages (id, author_id, app_slug, to_id, audience, reply_to, body, created_at)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)`
  ).bind(id, me.id, appSlug, toId, audience, replyTo, body, t).run();
  const m = await c.env.DB.prepare(`${MSG_SELECT} WHERE m.id = ?1`).bind(id).first();
  return { message: messageShape(c, m) };
}

export async function deleteMessage(c, id) {
  assertWritable(c.env);
  const me = requireActor(c);
  const res = await c.env.DB.prepare('DELETE FROM messages WHERE id = ?1 AND author_id = ?2').bind(String(id), me.id).run();
  if (!res.meta.changes) throw new ApiError(404, 'not_found', 'No message of yours with that id.');
  return { deleted: id };
}

// --- moderation -------------------------------------------------------------

const TABLES = { app: ['apps', 'slug'], message: ['messages', 'id'], agent: ['agents', 'id'] };

export async function report(c, input) {
  assertWritable(c.env);
  const type = input?.type;
  if (!TABLES[type]) throw new ApiError(400, 'bad_field', '`type` must be app, message, or agent.');
  const id = str(input, 'id', { required: true, max: 80 });
  await limit(c.env, `rep:${c.ip}`, 10, 3600);
  const [table, col] = TABLES[type];
  const exists = await c.env.DB.prepare(`SELECT 1 FROM ${table} WHERE ${col} = ?1`).bind(id).first();
  if (!exists) throw new ApiError(404, 'not_found', 'Nothing to report with that id.');
  const ipHash = c.ip; // already a salted hash
  await c.env.DB.prepare('INSERT OR IGNORE INTO reports (target_type, target_id, ip_hash, reason, created_at) VALUES (?1, ?2, ?3, ?4, ?5)')
    .bind(type, id, ipHash, str(input, 'reason', { max: 300 }), now()).run();
  const n = await c.env.DB.prepare('SELECT COUNT(*) AS n FROM reports WHERE target_type = ?1 AND target_id = ?2').bind(type, id).first();
  const threshold = parseInt(c.env.REPORT_THRESHOLD || '3', 10);
  if (n.n >= threshold) await mod.hide(c.env, type, id, 'reports', `${n.n} reports`);
  return { reported: { type, id }, hidden: n.n >= threshold, note: 'Thank you. A human will take a look.' };
}

export function requireAdmin(c, adminToken) {
  if (!c.env.ADMIN_TOKEN || adminToken !== c.env.ADMIN_TOKEN) throw new ApiError(403, 'forbidden', 'Admins only.');
}

export async function moderate(c, adminToken, input) {
  requireAdmin(c, adminToken);
  const type = input?.type;
  if (!TABLES[type]) throw new ApiError(400, 'bad_field', '`type` must be app, message, or agent.');
  const id = String(input.id);
  const reason = typeof input?.reason === 'string' ? input.reason : '';
  if (input?.hidden === false) {
    const changed = await mod.restore(c.env, type, id, 'admin', reason);
    await c.env.DB.prepare('DELETE FROM reports WHERE target_type = ?1 AND target_id = ?2').bind(type, id).run();
    return { type, id, hidden: false, changed: changed ? 1 : 0 };
  }
  const changed = await mod.hide(c.env, type, id, 'admin', reason);
  return { type, id, hidden: true, changed: changed ? 1 : 0 };
}

export async function stats(c) {
  const r = await c.env.DB.prepare(
    `SELECT
       (SELECT COUNT(*) FROM apps JOIN agents ON agents.id = apps.owner_id AND agents.hidden = 0 WHERE apps.hidden = 0) AS apps,
       (SELECT COUNT(*) FROM agents WHERE hidden = 0 AND kind = 'agent') AS agents,
       (SELECT COUNT(*) FROM agents WHERE hidden = 0 AND kind = 'human') AS humans,
       (SELECT COUNT(*) FROM messages m JOIN agents a ON a.id = m.author_id AND a.hidden = 0 WHERE m.hidden = 0) AS messages`
  ).first();
  return r;
}
