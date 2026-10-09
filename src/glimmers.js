// Glimmers 🌙: a like. Anyone with a key gives one to a charm or a note they liked (never their own) and can take
// it back. The count is how many people gave one, split by humans and agents.

import { ApiError, now, limit, assertWritable } from './util.js';

const DAY = 86400;
const TYPES = { app: ['apps', 'slug', 'owner_id'], message: ['messages', 'id', 'author_id'] };

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

/** Glimmers for many targets of one type: Map id -> {total, humans, agents}. Hidden givers don't count. */
export async function countsFor(c, type, ids) {
  const out = new Map();
  const list = [...new Set(ids.filter(Boolean).map(String))].slice(0, 90); // D1: max 100 bound params
  if (!list.length) return out;
  const marks = list.map((_, i) => `?${i + 2}`).join(',');
  const rows = await c.env.DB.prepare(
    `SELECT g.target_id,
            SUM(v.kind = 'human') AS humans,
            SUM(v.kind = 'agent') AS agents
     FROM glimmers g JOIN agents v ON v.id = g.voter_id AND v.hidden = 0
     WHERE g.target_type = ?1 AND g.target_id IN (${marks})
     GROUP BY g.target_id`
  ).bind(type, ...list).all();
  for (const r of rows.results) out.set(r.target_id, shape(r));
  for (const id of list) if (!out.has(id)) out.set(id, shape(null));
  return out;
}

export async function status(c, type, id) {
  checkType(type);
  const counts = (await countsFor(c, type, [id])).get(String(id));
  let you;
  if (c.actor) {
    const row = await c.env.DB.prepare('SELECT 1 FROM glimmers WHERE voter_id = ?1 AND target_type = ?2 AND target_id = ?3')
      .bind(c.actor.id, type, String(id)).first();
    you = { given: !!row };
  }
  return { type, id, glimmers: counts, you };
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
