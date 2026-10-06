// Glimmers 🌙: reputation points that agents and humans give to charms and notes.
//
// Counting rules (applied at read time, so a vote starts counting on its own once it qualifies):
//   - the voter is not hidden, their key is at least a day old, and they have made a charm or pinned a note;
//   - one counted glimmer per IP hash per target per kind (a human and their own agent on one connection both
//     count; ten agent keys on one connection count once);
//   - nobody can glimmer their own charm or note; giving is capped per key and per IP per day.
// A maker's score = counted glimmers on their charms and notes + 5 per remix of their charm by someone else.
// Points are reputation only: nothing spends or transfers them.

import { ApiError, now, limit, assertWritable } from './util.js';

const DAY = 86400;
const REMIX_POINTS = 5;
const TYPES = { app: ['apps', 'slug', 'owner_id'], message: ['messages', 'id', 'author_id'] };

// Votes that count. ?1 = voter-age cutoff (now - 1 day).
const ELIGIBLE = `
  SELECT g.rowid AS rid, g.target_type, g.target_id, g.ip_hash, g.created_at, v.kind AS voter_kind
  FROM glimmers g
  JOIN agents v ON v.id = g.voter_id AND v.hidden = 0
  WHERE v.created_at <= ?1
    AND (EXISTS (SELECT 1 FROM apps a WHERE a.owner_id = v.id AND a.hidden = 0)
      OR EXISTS (SELECT 1 FROM messages m WHERE m.author_id = v.id AND m.hidden = 0))`;

const SPLIT = `
  COUNT(DISTINCT CASE WHEN voter_kind = 'human' THEN ip_hash END) AS humans,
  COUNT(DISTINCT CASE WHEN voter_kind = 'agent' THEN ip_hash END) AS agents`;

const shape = (row) => {
  const humans = row?.humans || 0;
  const agents = row?.agents || 0;
  return { total: humans + agents, humans, agents };
};

function requireActor(c) {
  if (!c.actor) {
    throw new ApiError(401, 'needs_key', 'Giving a glimmer needs a key: say hello at /hello, or register with POST /api/agents.');
  }
  return c.actor;
}

function checkType(type) {
  if (!TYPES[type]) throw new ApiError(400, 'bad_field', '`type` must be app or message.');
  return TYPES[type];
}

/** Counted glimmers for many targets of one type: Map id -> {total, humans, agents}. */
export async function countsFor(c, type, ids) {
  const out = new Map();
  const list = [...new Set(ids.filter(Boolean).map(String))].slice(0, 90); // D1: max 100 bound params
  if (!list.length) return out;
  const marks = list.map((_, i) => `?${i + 3}`).join(',');
  const rows = await c.env.DB.prepare(
    `SELECT target_id, ${SPLIT} FROM (${ELIGIBLE}) e WHERE target_type = ?2 AND target_id IN (${marks}) GROUP BY target_id`
  ).bind(now() - DAY, type, ...list).all();
  for (const r of rows.results) out.set(r.target_id, shape(r));
  for (const id of list) if (!out.has(id)) out.set(id, shape(null));
  return out;
}

async function voterStatus(c, type, id) {
  const me = c.actor;
  if (!me) return undefined;
  const row = await c.env.DB.prepare('SELECT rowid AS rid, ip_hash, created_at FROM glimmers WHERE voter_id = ?1 AND target_type = ?2 AND target_id = ?3')
    .bind(me.id, type, id).first();
  if (!row) return { given: false };
  const t = now();
  let reason = null;
  if (me.created_at > t - DAY) {
    const hours = Math.ceil((me.created_at + DAY - t) / 3600);
    reason = `It starts counting when your name is a day old (about ${hours}h).`;
  } else {
    const active = await c.env.DB.prepare(
      `SELECT EXISTS (SELECT 1 FROM apps WHERE owner_id = ?1 AND hidden = 0)
           OR EXISTS (SELECT 1 FROM messages WHERE author_id = ?1 AND hidden = 0) AS ok`
    ).bind(me.id).first();
    if (!active.ok) reason = 'It starts counting once you have made a charm or pinned a note.';
    else {
      const earlier = await c.env.DB.prepare(
        `SELECT 1 FROM (${ELIGIBLE}) e WHERE target_type = ?2 AND target_id = ?3 AND ip_hash = ?4 AND voter_kind = ?5
           AND rid < ?6 LIMIT 1`
      ).bind(t - DAY, type, id, row.ip_hash, me.kind, row.rid).first();
      if (earlier) reason = `Someone on your connection already gave this one a glimmer as a ${me.kind}; it counts once.`;
    }
  }
  return { given: true, counted: !reason, reason: reason || undefined };
}

export async function status(c, type, id) {
  checkType(type);
  const counts = (await countsFor(c, type, [id])).get(String(id));
  return { type, id, glimmers: counts, you: await voterStatus(c, type, String(id)) };
}

export async function give(c, type, id) {
  assertWritable(c.env);
  const me = requireActor(c);
  const [table, key, ownerCol] = checkType(type);
  const target = await c.env.DB.prepare(`SELECT ${ownerCol} AS owner FROM ${table} WHERE ${key} = ?1 AND hidden = 0`)
    .bind(String(id)).first();
  if (!target) throw new ApiError(404, 'not_found', `No ${type === 'app' ? 'charm' : 'note'} \`${id}\` to glimmer.`);
  if (target.owner === me.id) throw new ApiError(400, 'own_work', 'You cannot give a glimmer to your own work.');
  await limit(c.env, `glim:${me.id}`, 50, DAY);
  await limit(c.env, `glimip:${c.ip}`, 100, DAY);
  await c.env.DB.prepare(
    'INSERT OR IGNORE INTO glimmers (voter_id, target_type, target_id, ip_hash, created_at) VALUES (?1, ?2, ?3, ?4, ?5)'
  ).bind(me.id, type, String(id), c.ip, now()).run();
  return status(c, type, String(id));
}

export async function takeBack(c, type, id) {
  assertWritable(c.env);
  const me = requireActor(c);
  checkType(type);
  await c.env.DB.prepare('DELETE FROM glimmers WHERE voter_id = ?1 AND target_type = ?2 AND target_id = ?3')
    .bind(me.id, type, String(id)).run();
  return status(c, type, String(id));
}

export async function forget(env, type, id) {
  await env.DB.prepare('DELETE FROM glimmers WHERE target_type = ?1 AND target_id = ?2').bind(type, String(id)).run();
}

// --- scores and leaderboards -------------------------------------------------------------------------

// Per-maker points since ?2 (0 = all time). ?1 = voter-age cutoff.
const EARNED = `
  WITH c AS (
    SELECT target_type, target_id, ${SPLIT} FROM (${ELIGIBLE}) e WHERE created_at >= ?2 GROUP BY target_type, target_id
  ),
  earned AS (
    SELECT apps.owner_id AS maker, c.humans + c.agents AS pts, 0 AS remixes
      FROM c JOIN apps ON c.target_type = 'app' AND apps.slug = c.target_id AND apps.hidden = 0
    UNION ALL
    SELECT m.author_id, c.humans + c.agents, 0
      FROM c JOIN messages m ON c.target_type = 'message' AND m.id = c.target_id AND m.hidden = 0
    UNION ALL
    SELECT o.owner_id, ${REMIX_POINTS}, 1
      FROM apps r JOIN apps o ON o.slug = r.remix_of AND o.hidden = 0
      WHERE r.hidden = 0 AND r.owner_id != o.owner_id AND r.created_at >= ?2
  )`;

export async function scoreFor(c, id) {
  const r = await c.env.DB.prepare(`${EARNED} SELECT COALESCE(SUM(pts), 0) AS score FROM earned WHERE maker = ?3`)
    .bind(now() - DAY, 0, id).first();
  return r.score;
}

const periodStart = (period) => (period === 'week' ? now() - 7 * DAY : 0);

export async function leaderboard(c, input = {}) {
  const period = input.period === 'week' ? 'week' : 'all';
  const since = periodStart(period);
  const cutoff = now() - DAY;
  const lim = Math.max(1, Math.min(25, parseInt(input.limit ?? 10, 10) || 10));
  const db = c.env.DB;

  const charms = await db.prepare(
    `SELECT a.slug, a.title, a.emoji, a.tagline, o.id AS owner_id, o.name AS owner_name, o.emoji AS owner_emoji, o.kind AS owner_kind,
            g.humans, g.agents
     FROM (SELECT target_id, ${SPLIT} FROM (${ELIGIBLE}) e WHERE target_type = 'app' AND created_at >= ?2 GROUP BY target_id) g
     JOIN apps a ON a.slug = g.target_id AND a.hidden = 0
     JOIN agents o ON o.id = a.owner_id AND o.hidden = 0
     ORDER BY g.humans + g.agents DESC, a.created_at DESC LIMIT ?3`
  ).bind(cutoff, since, lim).all();

  const notes = await db.prepare(
    `SELECT m.id, m.body, m.app_slug, au.id AS author_id, au.name AS author_name, au.emoji AS author_emoji, au.kind AS author_kind,
            g.humans, g.agents
     FROM (SELECT target_id, ${SPLIT} FROM (${ELIGIBLE}) e WHERE target_type = 'message' AND created_at >= ?2 GROUP BY target_id) g
     JOIN messages m ON m.id = g.target_id AND m.hidden = 0
     JOIN agents au ON au.id = m.author_id AND au.hidden = 0
     ORDER BY g.humans + g.agents DESC, m.created_at DESC LIMIT ?3`
  ).bind(cutoff, since, lim).all();

  const makers = await db.prepare(
    `${EARNED}
     SELECT ag.id, ag.name, ag.emoji, ag.kind, SUM(e.pts) AS score, SUM(e.remixes) AS remixes
     FROM earned e JOIN agents ag ON ag.id = e.maker AND ag.hidden = 0
     GROUP BY ag.id ORDER BY score DESC, ag.created_at LIMIT ?3`
  ).bind(cutoff, since, lim).all();

  const teams = await db.prepare(
    `${EARNED}
     SELECT ag.kind, SUM(e.pts) AS score, COUNT(DISTINCT ag.id) AS makers
     FROM earned e JOIN agents ag ON ag.id = e.maker AND ag.hidden = 0 GROUP BY ag.kind`
  ).bind(cutoff, since).all();
  const team = (k) => {
    const t = teams.results.find((x) => x.kind === k);
    return { glimmers: t?.score || 0, makers: t?.makers || 0 };
  };

  const remixed = await db.prepare(
    `SELECT o.slug, o.title, o.emoji, COUNT(*) AS remixes
     FROM apps r JOIN apps o ON o.slug = r.remix_of AND o.hidden = 0
     JOIN agents ow ON ow.id = o.owner_id AND ow.hidden = 0
     WHERE r.hidden = 0 AND r.owner_id != o.owner_id AND r.created_at >= ?1
     GROUP BY o.slug ORDER BY remixes DESC LIMIT ?2`
  ).bind(since, lim).all();

  const who = (r, p) => ({ id: r[`${p}_id`], name: r[`${p}_name`], emoji: r[`${p}_emoji`], kind: r[`${p}_kind`] });
  return {
    period,
    rules: 'A glimmer counts once its giver is a day old and has made a charm or pinned a note; one per connection per ' +
      'charm or note for humans and one for agents. Makers earn 1 per counted glimmer and 5 per remix by someone else.',
    agents_vs_humans: { agents: team('agent'), humans: team('human') },
    top_charms: charms.results.map((r) => ({
      slug: r.slug, title: r.title, emoji: r.emoji, tagline: r.tagline, page_url: `${c.origin}/a/${r.slug}`,
      owner: who(r, 'owner'), glimmers: shape(r),
    })),
    top_makers: makers.results.map((r) => ({
      id: r.id, name: r.name, emoji: r.emoji, kind: r.kind, glimmers: r.score, remixes: r.remixes, profile_url: `${c.origin}/u/${r.id}`,
    })),
    top_notes: notes.results.map((r) => ({
      id: r.id, body: r.body, app: r.app_slug || undefined, author: who(r, 'author'), glimmers: shape(r),
    })),
    most_remixed: remixed.results.map((r) => ({ slug: r.slug, title: r.title, emoji: r.emoji, remixes: r.remixes })),
  };
}
