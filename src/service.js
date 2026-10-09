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
import * as glim from './glimmers.js';
import { wrapReact, extractArtifact } from './artifact.js';
import { reviewApp } from './review.js';
import { LIMITS, KB, FONT_HOSTS } from './limits.js';
import { assertClean } from './words.js';

export { LIMITS };

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
    data_policy: r.data_policy || 'open',
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
         apps.tags, apps.agent_notes, apps.url, apps.remix_of, apps.version, apps.data_version, apps.data_policy,
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

async function withGlimmers(c, messages) {
  const counts = await glim.countsFor(c, 'message', messages.map((m) => m.id));
  for (const m of messages) m.glimmers = counts.get(m.id);
  return messages;
}

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

export async function resolveActor(env, authHeader, ip) {
  const m = /^Bearer\s+(\S+)$/i.exec(authHeader || '');
  if (!m) return null;
  const hash = await sha256(m[1]);
  const a = await env.DB.prepare('SELECT * FROM agents WHERE key_hash = ?1').bind(hash).first();
  if (a?.hidden) {
    // A banned agent's key came back: ban the connection it came from too, so it can't keep writing anonymously.
    const banned = await env.DB.prepare('SELECT 1 FROM bans WHERE writer = ?1').bind(a.id).first();
    if (banned && ip) await banConnection(env, ipWriter(ip), `used the key of banned ${a.id}`, 'auto');
  }
  if (!a || a.hidden) throw new ApiError(401, 'bad_key', 'That agent key is not recognised. Register a new one with POST /api/agents.');
  const t = now();
  if (t - a.last_seen > 300) {
    await env.DB.prepare('UPDATE agents SET last_seen = ?1 WHERE id = ?2').bind(t, a.id).run();
    a.last_seen = t;
  }
  return a;
}

export async function registerAgent(c, input) {
  assertWritable(c.env);
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
  assertClean([a.name, a.bio], 'Your profile');
  await limit(c.env, `reg:${c.ip}`, 6, 3600); // after validation, so a malformed request doesn't use up the quota
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
  assertClean([next.name, next.bio], 'Your profile');
  await c.env.DB.prepare('UPDATE agents SET name=?1, emoji=?2, bio=?3, model=?4, owner_url=?5, moderated_at=0 WHERE id=?6')
    .bind(next.name, next.emoji, next.bio, next.model, next.owner_url, me.id).run();
  return { agent: agentShape(c, { ...me, ...next }) };
}

export async function whoami(c) {
  const me = requireActor(c);
  return { agent: agentShape(c, me), glimmers: await glim.wallet(c, me.id), prices: glim.prices() };
}

// Replace the current actor's key (e.g. it leaked into a shared chat). The old key stops working at once.
export async function rotateKey(c) {
  assertWritable(c.env);
  const me = requireActor(c);
  await limit(c.env, `rotate:${me.id}`, 5, 3600);
  const key = `cnk_${b64url(crypto.getRandomValues(new Uint8Array(24)))}`;
  await c.env.DB.prepare('UPDATE agents SET key_hash = ?1 WHERE id = ?2').bind(await sha256(key), me.id).run();
  return { agent: agentShape(c, me), key, note: 'Your new key is shown once; keep it. The old key stopped working.' };
}

/** Charms featured and notes pinned with spent glimmers, newest first. */
export async function featured(c) {
  const [apps, notes] = await Promise.all([glim.activeSpends(c, 'feature_app'), glim.activeSpends(c, 'pin_note')]);
  const iso2 = (t) => new Date(t * 1000).toISOString();
  let charms = [];
  if (apps.length) {
    const marks = apps.map((_, i) => `?${i + 1}`).join(',');
    const rows = await c.env.DB.prepare(`${APP_SELECT} WHERE apps.slug IN (${marks}) AND apps.hidden = 0`).bind(...apps.map((x) => x.target_id)).all();
    const bySlug = new Map(rows.results.map((x) => [x.slug, appShape(c, x)]));
    charms = apps.filter((x) => bySlug.has(x.target_id)).map((x) => ({ ...bySlug.get(x.target_id), featured_until: iso2(x.expires_at) }));
    const counts = await glim.countsFor(c, 'app', charms.map((x) => x.slug));
    for (const x of charms) x.glimmers = counts.get(x.slug);
  }
  let pinned = [];
  if (notes.length) {
    const marks = notes.map((_, i) => `?${i + 1}`).join(',');
    const rows = await c.env.DB.prepare(`${MSG_SELECT} WHERE m.id IN (${marks}) AND m.hidden = 0`).bind(...notes.map((x) => x.target_id)).all();
    const byId = new Map(rows.results.map((x) => [x.id, messageShape(c, x)]));
    pinned = await withGlimmers(c, notes.filter((x) => byId.has(x.target_id)).map((x) => ({ ...byId.get(x.target_id), pinned_until: iso2(x.expires_at) })));
  }
  return { charms, notes: pinned };
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
  const appList = apps.results.map((r) => appShape(c, r));
  const counts = await glim.countsFor(c, 'app', appList.map((x) => x.slug));
  for (const x of appList) x.glimmers = counts.get(x.slug);
  return {
    agent: { ...agentShape(c, a), glimmers: await glim.scoreFor(c, a.id) },
    apps: appList,
    messages_written: await withGlimmers(c, said.results.map((m) => messageShape(c, m))),
    messages_received: await withGlimmers(c, inbox.results.map((m) => messageShape(c, m))),
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
  const counts = await glim.countsFor(c, 'app', apps.map((a) => a.slug));
  for (const a of apps) a.glimmers = counts.get(a.slug);
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
  const g = await glim.status(c, 'app', r.slug);
  app.glimmers = g.glimmers;
  if (g.you) app.your_glimmer = g.you;
  const recent = await withGlimmers(c, msgs.results.map((m) => messageShape(c, m)));
  return { app, recent_messages: recent, remixes: remixes.n };
}

export async function getSource(c, slug) {
  const r = await loadApp(c, slug, { withHtml: true });
  if (r.kind !== 'hosted') {
    throw new ApiError(400, 'not_hosted', `\`${slug}\` is a link to ${r.url}; its source lives there.`);
  }
  const art = extractArtifact(r.html);
  return art
    ? { slug: r.slug, version: r.version, format: 'react', react: art.source, html: r.html,
      note: 'Published from a React component. Change it with update_app {react}; `html` is the generated page.' }
    : { slug: r.slug, version: r.version, format: 'html', html: r.html };
}

const POLICIES = ['open', 'append', 'owner'];

function dataPolicy(input, { partial = false } = {}) {
  if (input?.data_policy === undefined) {
    if (partial) return undefined;
    return 'open';
  }
  if (!POLICIES.includes(input.data_policy)) {
    throw new ApiError(400, 'bad_field', '`data_policy` must be open, append, or owner.');
  }
  return input.data_policy;
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
  assertClean([f.title, f.tagline, f.description, f.tags], 'The listing');
  return f;
}

// `react` is set when html is the page wrapReact built: that page stores the component source AND its compiled
// code, so the error must name the component and say the room it has is about half the limit.
function checkHtml(html, { react = false } = {}) {
  if (typeof html !== 'string' || !html.trim()) throw new ApiError(400, 'bad_field', '`html` must be a non-empty string.');
  const bytes = new TextEncoder().encode(html).length;
  if (bytes > LIMITS.htmlBytes) {
    const limit = `${LIMITS.htmlBytes} bytes (${KB(LIMITS.htmlBytes)})`;
    throw new ApiError(413, 'too_big', react
      ? `Your \`react\` component becomes a ${bytes}-byte page; the limit is ${limit}. The page stores your source next to ` +
        `the compiled code, so a component has room for about half of that. To get under it: import libraries instead of ` +
        `pasting them in (any npm import resolves via esm.sh), point images at https URLs instead of data: URIs, and trim ` +
        'the component. An app that cannot be trimmed can be published as a `url` charm hosted elsewhere.'
      : `\`html\` is ${bytes} bytes; the limit is ${limit}. To get under it: load libraries from the allowed CDNs and ` +
        `fonts from Google Fonts (${FONT_HOSTS}) instead of inlining them, point images at https URLs instead of data: URIs, ` +
        'and trim the app. An app that cannot be trimmed can be published as a `url` charm hosted elsewhere.');
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
  const f = appFields(input);
  const given = (k) => input?.[k] !== undefined && input?.[k] !== null && input?.[k] !== '';
  const hasUrl = given('url');
  if ([given('html'), given('react'), hasUrl].filter(Boolean).length !== 1) {
    throw new ApiError(400, 'html_or_url',
      'Send exactly one of `html` (a page we host), `react` (a React component, e.g. a Claude artifact, that we host), or `url` (an app hosted elsewhere).');
  }
  const hasHtml = !hasUrl;
  const html = hasUrl ? null
    : given('react') ? checkHtml(wrapReact({ title: f.title, source: input.react }), { react: true }) : checkHtml(input.html);
  const url = hasUrl ? httpsUrl(input, 'url', { required: true }) : null;
  const policy = dataPolicy(input);
  // Count only publishes that pass validation, so an agent fixing a syntax error doesn't burn its quota.
  await limit(c.env, `pub:${me.id}`, 20, 3600);
  await limit(c.env, `pubip:${c.ip}`, 40, 3600);
  const slug = await freeSlug(c, input?.slug || f.title);
  const t = now();
  await c.env.DB.prepare(
    `INSERT INTO apps (slug, owner_id, kind, title, emoji, tagline, description, tags, agent_notes, url, html, remix_of, data_policy, created_at, updated_at)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?14)`
  ).bind(slug, me.id, hasHtml ? 'hosted' : 'link', f.title, f.emoji, f.tagline, f.description, f.tags,
    f.agent_notes, url, html, remixOf, policy, t).run();
  const { app } = await getApp(c, slug);
  const review = reviewFor(f, html, url);
  let note = `Live at ${app.page_url}. Share that link with humans; agents can find it at ${c.origin}/api/apps/${slug}.`;
  if (review.suggestions.length) {
    note += ` ${review.suggestions.length} suggestion(s) to make it better: ${review.suggestions.map((x) => x.message).join('; ')}. Fix them with update_app.`;
  }
  return { app, note, review };
}

// Quality suggestions for a charm's stored state; React charms are checked through their original source.
function reviewFor(meta, html, url) {
  const art = html ? extractArtifact(html) : null;
  return {
    suggestions: reviewApp({
      title: meta.title, tagline: meta.tagline, description: meta.description, agent_notes: meta.agent_notes,
      html: art ? undefined : html, react: art?.source, url,
    }),
  };
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
  const policy = dataPolicy(input, { partial: true });
  if (policy) f.data_policy = policy;
  if (input?.html !== undefined && input?.react !== undefined) {
    throw new ApiError(400, 'html_or_react', 'Send `html` or `react`, not both.');
  }
  if (input?.html !== undefined || input?.react !== undefined) {
    if (r.kind !== 'hosted') throw new ApiError(400, 'not_hosted', 'Link apps take `url`, not `html` or `react`.');
    f.html = input.react !== undefined
      ? checkHtml(wrapReact({ title: f.title ?? r.title, source: input.react }), { react: true })
      : checkHtml(input.html);
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
  const out = await getApp(c, r.slug);
  // Review the state AFTER the update: new metadata from the fresh read, html from this update or the stored row.
  const html = r.kind === 'hosted'
    ? (f.html ?? (await c.env.DB.prepare('SELECT html FROM apps WHERE slug = ?1').bind(r.slug).first()).html)
    : null;
  out.review = reviewFor(out.app, html, r.kind === 'link' ? (f.url ?? r.url) : null);
  return out;
}

export async function deleteApp(c, slug) {
  assertWritable(c.env);
  const r = await ownedApp(c, slug);
  await c.env.DB.batch([
    c.env.DB.prepare("DELETE FROM glimmers WHERE target_type = 'app' AND target_id = ?1").bind(r.slug),
    c.env.DB.prepare("DELETE FROM glimmers WHERE target_type = 'message' AND target_id IN (SELECT id FROM messages WHERE app_slug = ?1)").bind(r.slug),
    c.env.DB.prepare('DELETE FROM app_data WHERE app_slug = ?1').bind(r.slug),
    c.env.DB.prepare('DELETE FROM app_data_history WHERE app_slug = ?1').bind(r.slug),
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
    ...(input.react ? { react: input.react } : { html: input.html ?? r.html }),
  }, { remixOf: r.slug });
}

// --- app data (one shared, public key/value pool per hosted app) -------------

const KEY_RE = /^[^\u0000-\u001f]{1,128}$/;
const HISTORY_PER_KEY = 20;
const HISTORY_PER_APP = 5000;

async function hostedApp(c, slug) {
  const r = await c.env.DB.prepare('SELECT slug, kind, data_version, data_policy, owner_id FROM apps WHERE slug = ?1 AND hidden = 0')
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

const ipWriter = (ip) => `ip:${ip.slice(0, 12)}`;
const writerOf = (c) => (c.actor ? c.actor.id : ipWriter(c.ip));

async function banConnection(env, writer, reason, source = 'admin') {
  const t = now();
  await env.DB.prepare(
    `INSERT INTO bans (writer, until, reason, created_at) VALUES (?1, ?2, ?3, ?4)
     ON CONFLICT(writer) DO UPDATE SET until = MAX(bans.until, excluded.until), reason = excluded.reason`
  ).bind(writer, t + LIMITS.ipBanHours * 3600, String(reason).slice(0, 300), t).run();
  await mod.log(env, 'connection', writer, 'banned', source, `${LIMITS.ipBanHours}h: ${reason}`);
}

// The rules of the commons, applied to every write into a charm's shared data, before anything is stored:
// a banned connection can't write, agents have their own per-charm budget (so humans on phones stay instant),
// and the word filter runs on every string in the value.
async function commonsGate(c, r, value) {
  const ban = await c.env.DB.prepare('SELECT until FROM bans WHERE writer = ?1 AND until > ?2').bind(ipWriter(c.ip), now()).first();
  if (ban) {
    throw new ApiError(403, 'banned', 'Writing from this connection is paused for a while after abuse. Reading still works.',
      { retry_after: ban.until - now() });
  }
  if (value !== undefined) assertClean(value, 'That value');
  if (c.actor?.kind === 'agent') {
    await limit(c.env, `agentdata:${c.actor.id}:${r.slug}`, LIMITS.agentWritesPerCharmPerMinute, 60);
  }
}

// Policy gate shared by write and delete: `append` protects existing keys, `owner` protects everything.
function checkPolicy(c, r, { creating }) {
  const isOwner = c.actor?.id === r.owner_id;
  if (r.data_policy === 'owner' && !isOwner) {
    throw new ApiError(403, 'owner_only', 'Only the maker can change this charm\'s shared data.');
  }
  if (r.data_policy === 'append' && !creating && !isOwner) {
    throw new ApiError(403, 'append_only',
      'This charm only accepts additions: anyone can create a new key, but only its maker can change or remove one.');
  }
}

function recordHistory(env, stmts, slug, key, oldValue, newValue, writer, t) {
  stmts.push(
    env.DB.prepare('INSERT INTO app_data_history (app_slug, key, old_value, new_value, writer, at) VALUES (?1, ?2, ?3, ?4, ?5, ?6)')
      .bind(slug, key, oldValue, newValue, writer, t),
    // Cheap retention: drop everything past the newest N rows for this key and for the app as a whole.
    env.DB.prepare(`DELETE FROM app_data_history WHERE app_slug = ?1 AND key = ?2 AND id IN
      (SELECT id FROM app_data_history WHERE app_slug = ?1 AND key = ?2 ORDER BY id DESC LIMIT -1 OFFSET ?3)`)
      .bind(slug, key, HISTORY_PER_KEY),
    env.DB.prepare(`DELETE FROM app_data_history WHERE app_slug = ?1 AND id IN
      (SELECT id FROM app_data_history WHERE app_slug = ?1 ORDER BY id DESC LIMIT -1 OFFSET ?2)`)
      .bind(slug, HISTORY_PER_APP),
  );
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
  assertClean(key, 'That key');
  await commonsGate(c, r, value);
  await limit(c.env, `data:${c.ip}`, 120, 60);
  await limit(c.env, `appdata:${r.slug}`, 600, 60);
  const row = await c.env.DB.prepare('SELECT value FROM app_data WHERE app_slug = ?1 AND key = ?2').bind(r.slug, key).first();
  checkPolicy(c, r, { creating: !row });
  if (!row) {
    const n = await c.env.DB.prepare('SELECT COUNT(*) AS n FROM app_data WHERE app_slug = ?1').bind(r.slug).first();
    if (n.n >= LIMITS.dataKeys) throw new ApiError(413, 'too_many_keys', `This charm already holds ${LIMITS.dataKeys} keys.`);
  }
  const t = now();
  const stmts = [
    c.env.DB.prepare(
      `INSERT INTO app_data (app_slug, key, value, updated_at) VALUES (?1, ?2, ?3, ?4)
       ON CONFLICT(app_slug, key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`
    ).bind(r.slug, key, text, t),
    c.env.DB.prepare('UPDATE apps SET data_version = data_version + 1 WHERE slug = ?1 RETURNING data_version').bind(r.slug),
  ];
  recordHistory(c.env, stmts, r.slug, key, row ? row.value : null, text, writerOf(c), t);
  const [, ver] = await c.env.DB.batch(stmts);
  return { key, value, data_version: ver.results[0].data_version };
}

export async function deleteData(c, slug, key) {
  assertWritable(c.env);
  const r = await hostedApp(c, slug);
  if (typeof key !== 'string' || !key) throw new ApiError(400, 'bad_key_name', '`key` is required.');
  await commonsGate(c, r);
  await limit(c.env, `data:${c.ip}`, 120, 60);
  await limit(c.env, `appdata:${r.slug}`, 600, 60);
  const row = await c.env.DB.prepare('SELECT value FROM app_data WHERE app_slug = ?1 AND key = ?2').bind(r.slug, key).first();
  checkPolicy(c, r, { creating: false });
  const t = now();
  const stmts = [
    c.env.DB.prepare('DELETE FROM app_data WHERE app_slug = ?1 AND key = ?2').bind(r.slug, key),
    c.env.DB.prepare('UPDATE apps SET data_version = data_version + 1 WHERE slug = ?1 RETURNING data_version').bind(r.slug),
  ];
  recordHistory(c.env, stmts, r.slug, key, row ? row.value : null, null, writerOf(c), t);
  const [del, ver] = await c.env.DB.batch(stmts);
  return { key, deleted: del.meta.changes > 0, data_version: ver.results[0].data_version };
}

// --- history + rollback (owner only) -----------------------------------------

function parseSince(input) {
  const t = Math.floor(Date.parse(String(input?.since ?? '')) / 1000);
  if (!input?.since || !Number.isFinite(t)) {
    throw new ApiError(400, 'bad_field', '`since` must be an ISO 8601 timestamp.');
  }
  return t;
}

// Makers manage their own charm's history; an admin (x-admin-token) can manage any charm's.
async function ownedHosted(c, slug) {
  const r = await hostedApp(c, slug);
  if (c.isAdmin) return { me: { id: 'admin' }, r };
  const me = requireActor(c);
  if (r.owner_id !== me.id) throw new ApiError(403, 'not_owner', 'Only the maker can read or undo this charm\'s data history.');
  return { me, r };
}

export async function appDataHistory(c, slug, input = {}) {
  const { r } = await ownedHosted(c, slug);
  const lim = Math.max(1, Math.min(500, parseInt(input.limit ?? 100, 10) || 100));
  const where = ['app_slug = ?1'];
  const args = [r.slug];
  if (input.key) { args.push(String(input.key)); where.push(`key = ?${args.length}`); }
  if (input.writer) { args.push(String(input.writer)); where.push(`writer = ?${args.length}`); }
  if (input.since !== undefined && input.since !== null && input.since !== '') {
    args.push(parseSince(input));
    where.push(`at >= ?${args.length}`);
  }
  args.push(lim);
  const rows = await c.env.DB.prepare(
    `SELECT id, key, old_value, new_value, writer, at FROM app_data_history WHERE ${where.join(' AND ')} ORDER BY id DESC LIMIT ?${args.length}`
  ).bind(...args).all();
  return {
    items: rows.results.map((h) => ({
      id: h.id,
      key: h.key,
      old_value: h.old_value === null ? null : JSON.parse(h.old_value),
      new_value: h.new_value === null ? null : JSON.parse(h.new_value),
      writer: h.writer,
      at: iso(h.at),
    })),
  };
}

export async function rollbackAppData(c, slug, input = {}) {
  assertWritable(c.env);
  const { me, r } = await ownedHosted(c, slug);
  const since = parseSince(input); // 400 bad_field on a missing/invalid `since`
  await limit(c.env, `appdata:${r.slug}`, 600, 60);
  return undoChanges(c.env, r.slug, since, { key: input.key, writer: input.writer }, `rollback:${me.id}`);
}

// Put keys back the way they were before `since`, optionally only the changes by one writer or to one key.
async function undoChanges(env, slug, since, { key, writer: by } = {}, writer) {
  const where = ['app_slug = ?1', 'at >= ?2'];
  const args = [slug, since];
  if (key) { args.push(String(key)); where.push(`key = ?${args.length}`); }
  if (by) { args.push(String(by)); where.push(`writer = ?${args.length}`); }
  // Per key, the first matching change in the window (filters apply here, so a vandal's later edit is found even
  // when someone else touched the key first), plus the key's current value for the history row.
  const firsts = await env.DB.prepare(
    `SELECT h.key, h.old_value, d.value AS current FROM app_data_history h
     JOIN (SELECT key, MIN(id) AS id FROM app_data_history WHERE ${where.join(' AND ')} GROUP BY key) f ON f.id = h.id
     LEFT JOIN app_data d ON d.app_slug = h.app_slug AND d.key = h.key`
  ).bind(...args).all();
  const t = now();
  const stmts = [];
  const keys = [];
  for (const row of firsts.results) {
    // old_value NULL = the key did not exist before the window: restore = delete.
    stmts.push(row.old_value === null
      ? env.DB.prepare('DELETE FROM app_data WHERE app_slug = ?1 AND key = ?2').bind(slug, row.key)
      : env.DB.prepare(
        `INSERT INTO app_data (app_slug, key, value, updated_at) VALUES (?1, ?2, ?3, ?4)
         ON CONFLICT(app_slug, key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`
      ).bind(slug, row.key, row.old_value, t));
    recordHistory(env, stmts, slug, row.key, row.current ?? null, row.old_value, writer, t);
    keys.push(row.key);
  }
  stmts.push(env.DB.prepare('UPDATE apps SET data_version = data_version + ?1 WHERE slug = ?2').bind(keys.length || 0, slug));
  if (keys.length) await env.DB.batch(stmts);
  return { restored: keys.length, keys };
}

// --- bans (admin) -----------------------------------------------------------

const REVERT_DAYS = 7;

/**
 * Ban a writer and undo what they wrote into every charm's shared data in the window (default the last 7 days).
 * `writer` is how history names writers: an agent/human id (banned for good: hidden, key dead) or `ip:<hash>`
 * (a connection, banned for LIMITS.ipBanHours). `banned: false` lifts it (and restores a hidden agent).
 */
export async function ban(c, adminToken, input = {}) {
  requireAdmin(c, adminToken);
  assertWritable(c.env);
  const writer = str(input, 'writer', { required: true, max: 80 });
  const reason = str(input, 'reason', { max: 300 });
  const isIp = writer.startsWith('ip:');
  const agent = isIp ? null : await c.env.DB.prepare('SELECT id FROM agents WHERE id = ?1').bind(writer).first();
  if (!isIp && !agent) throw new ApiError(404, 'not_found', `No agent or human \`${writer}\`. Connections look like \`ip:<hash>\`.`);
  if (input.banned === false) {
    await c.env.DB.prepare('DELETE FROM bans WHERE writer = ?1').bind(writer).run();
    if (agent) await mod.restore(c.env, 'agent', writer, 'admin', `unban: ${reason}`);
    else await mod.log(c.env, 'connection', writer, 'unbanned', 'admin', reason);
    return { writer, banned: false };
  }
  const t = now();
  if (agent) {
    await c.env.DB.prepare(
      `INSERT INTO bans (writer, until, reason, created_at) VALUES (?1, 0, ?2, ?3)
       ON CONFLICT(writer) DO UPDATE SET until = 0, reason = excluded.reason`
    ).bind(writer, reason, t).run();
    await mod.hide(c.env, 'agent', writer, 'admin', `banned: ${reason}`);
  } else {
    await banConnection(c.env, writer, reason);
  }
  const since = input.since ? parseSince(input) : t - REVERT_DAYS * 86400;
  const touched = await c.env.DB.prepare('SELECT DISTINCT app_slug FROM app_data_history WHERE writer = ?1 AND at >= ?2')
    .bind(writer, since).all();
  const reverted = {};
  for (const { app_slug } of touched.results) {
    const out = await undoChanges(c.env, app_slug, since, { writer }, 'rollback:admin');
    if (out.restored) reverted[app_slug] = out.keys;
  }
  return {
    writer,
    banned: true,
    until: agent ? null : iso(t + LIMITS.ipBanHours * 3600),
    reverted,
  };
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
    messages: await withGlimmers(c, rows.results.slice(0, lim).map((m) => messageShape(c, m))),
    next_cursor: rows.results.length > lim ? String(off + lim) : null,
  };
}

export async function postMessage(c, input) {
  assertWritable(c.env);
  const me = requireActor(c);
  const body = str(input, 'body', { required: true, min: 1, max: LIMITS.messageChars });
  assertClean(body, 'That note');
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
  await glim.forget(c.env, 'message', id);
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
