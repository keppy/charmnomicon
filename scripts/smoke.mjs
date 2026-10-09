// End-to-end smoke test against a running instance (local `npm run dev` or a deploy).
// Usage: node scripts/smoke.mjs [base-url]
// Exercises every surface: JSON API, hosted runtime + CSP, HTML pages, MCP, and the failure paths.


const BASE = (process.argv[2] || process.env.CHARM_BASE || 'http://localhost:8787').replace(/\/$/, '');
// Retry once when the server closed a kept-alive connection while we were busy (e.g. the slow local
// `wrangler d1 execute` step below): the request never reached the server, so a retry is safe.
const rawFetch = globalThis.fetch;
globalThis.fetch = async (...args) => {
  try {
    return await rawFetch(...args);
  } catch (e) {
    if (['ECONNRESET', 'UND_ERR_SOCKET'].includes(e?.cause?.code)) return rawFetch(...args);
    throw e;
  }
};
let passed = 0;
const fails = [];
const created = []; // agent ids this run registered; hidden at the end when an admin token is available
const ADMIN_TOKEN = process.env.CHARM_ADMIN_TOKEN || (/localhost|127\.0\.0\.1/.test(BASE) ? 'dev-admin' : null);
const tag = Math.random().toString(36).slice(2, 7);

function check(name, cond, detail = '') {
  if (cond) passed++;
  else fails.push(`${name}${detail ? `: ${detail}` : ''}`);
}

async function call(method, path, body, key) {
  const res = await fetch(BASE + path, {
    method,
    headers: { 'content-type': 'application/json', ...(key ? { authorization: `Bearer ${key}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const t = await res.text();
  let data;
  try { data = JSON.parse(t); } catch { data = t; }
  return { status: res.status, data, headers: res.headers };
}

let rpcId = 0;
async function mcp(method, params, key) {
  const r = await call('POST', '/mcp', { jsonrpc: '2.0', id: ++rpcId, method, params }, key);
  return r.data;
}

async function main() {
  // agents
  const a = await call('POST', '/api/agents', { name: `Smoke Wren ${tag}`, emoji: '🐦', bio: 'smoke test', model: 'test' });
  if (a.status === 429) {
    console.log(`Registration is rate limited from this IP (retry in ${a.data.error.retry_after}s). The smoke test needs 4 fresh keys.`);
    process.exitCode = 2;
    return;
  }
  check('register agent', a.status === 200 && a.data.key?.startsWith('cnk_'), JSON.stringify(a.data));
  let keyA = a.data.key;
  created.push(a.data.agent.id);
  const b = await call('POST', '/api/agents', { name: `Smoke Human ${tag}`, kind: 'human' });
  if (b.data.agent) created.push(b.data.agent.id);
  check('register human', b.status === 200 && b.data.agent.kind === 'human');
  const keyB = b.data.key;
  check('whoami', (await call('GET', '/api/me', undefined, keyA)).data.agent?.id === a.data.agent.id);
  check('bad key -> 401', (await call('GET', '/api/me', undefined, 'cnk_nope')).status === 401);
  check('empty name -> 400', (await call('POST', '/api/agents', { name: '' })).status === 400);

  // key rotation: HTTP first, then MCP on the HTTP-rotated key
  const rot = await call('POST', '/api/agents/me/rotate-key', {}, keyA);
  check('rotate over HTTP', rot.status === 200 && rot.data.key?.startsWith('cnk_') && rot.data.agent?.id === a.data.agent.id,
    JSON.stringify(rot.data).slice(0, 200));
  check('old key dead after rotate', (await call('GET', '/api/me', undefined, keyA)).status === 401);
  const keyA2 = rot.data.key;
  check('new key works', (await call('GET', '/api/me', undefined, keyA2)).data.agent?.id === a.data.agent.id);
  const rot2 = await mcp('tools/call', { name: 'rotate_key', arguments: { agent_key: keyA2 } });
  check('rotate over MCP', rot2.result?.isError === false && rot2.result.structuredContent.key?.startsWith('cnk_'),
    JSON.stringify(rot2).slice(0, 300));
  check('HTTP-rotated key dead', (await call('GET', '/api/me', undefined, keyA2)).status === 401);
  const keyA3 = rot2.result?.structuredContent?.key;
  check('MCP-rotated key works', (await call('GET', '/api/me', undefined, keyA3)).data.agent?.id === a.data.agent.id);
  keyA = keyA3; // the smoke test keeps using the live key from here on
  check('rotate needs key', (await call('POST', '/api/agents/me/rotate-key', {})).status === 401);

  // publish
  const html = '<!doctype html><html><head><title>t</title></head><body><p id=x>hi</p><script>charm.set("hello", {n:1})</script></body></html>';
  check('publish without key -> 401', (await call('POST', '/api/apps', { title: 'nope', html })).status === 401);
  check('html AND url -> 400', (await call('POST', '/api/apps', { title: 'x', html, url: 'https://example.com' }, keyA)).status === 400);
  check('http url -> 400', (await call('POST', '/api/apps', { title: 'x', url: 'http://example.com' }, keyA)).status === 400);
  const p = await call('POST', '/api/apps', {
    title: `Smoke Charm ${tag}`, emoji: '🧪', tagline: 'testing <b>escapes</b>', tags: ['Test', 'smoke'], html,
    agent_notes: 'key `hello`',
  }, keyA);
  check('publish hosted', p.status === 200 && p.data.app.kind === 'hosted', JSON.stringify(p.data));
  const slug = p.data.app.slug;
  check('tags normalised', JSON.stringify(p.data.app.tags) === '["test","smoke"]', JSON.stringify(p.data.app.tags));
  const link = await call('POST', '/api/apps', { title: `Smoke Link ${tag}`, url: 'https://example.com/app' }, keyA);
  check('publish link', link.status === 200 && link.data.app.kind === 'link' && link.data.app.external_url === 'https://example.com/app');

  // Over the size limit: 413 too_big with byte counts and recovery steps, rejected before the publish quota.
  const bigHtml = await call('POST', '/api/apps', { title: 'big', html: `<!doctype html><p>${'x'.repeat(560 * 1024)}</p>` }, keyA);
  check('oversized html -> 413 too_big', bigHtml.status === 413 && bigHtml.data.error?.code === 'too_big' &&
    /^`html` is \d+ bytes; the limit is 524288 bytes \(512KB\)/.test(bigHtml.data.error.message) &&
    bigHtml.data.error.message.includes('fonts.googleapis.com'), JSON.stringify(bigHtml.data).slice(0, 300));
  const bigM = await mcp('tools/call', { name: 'publish_app', arguments: { title: 'big', html: `<p>${'z'.repeat(560 * 1024)}</p>`, agent_key: keyA } });
  check('mcp oversized html -> isError too_big', bigM.result?.isError === true && JSON.stringify(bigM.result).includes('too_big'),
    JSON.stringify(bigM).slice(0, 300));

  // read
  const list = await call('GET', `/api/apps?query=${tag}`);
  check('search finds both', list.data.apps?.length === 2, JSON.stringify(list.data).slice(0, 200));
  check('listing omits html', !('html' in (list.data.apps?.[0] || {})));
  check('tag filter', (await call('GET', `/api/apps?tag=smoke&query=${tag}`)).data.apps.length === 1);
  const one = await call('GET', `/api/apps/${slug}`);
  check('get app', one.data.app?.agent_notes === 'key `hello`');
  check('agent view counted', one.data.app.views.agents >= 0);
  check('source', (await call('GET', `/api/apps/${slug}/source`)).data.html === html);
  check('missing app -> 404', (await call('GET', '/api/apps/does-not-exist-xyz')).status === 404);

  // update + ownership + concurrency
  check('non-owner update -> 403', (await call('PATCH', `/api/apps/${slug}`, { tagline: 'hijack' }, keyB)).status === 403);
  const up = await call('PATCH', `/api/apps/${slug}`, { tagline: 'updated', version: 1 }, keyA);
  check('owner update', up.status === 200 && up.data.app.version === 2 && up.data.app.tagline === 'updated');
  check('stale version -> 409', (await call('PATCH', `/api/apps/${slug}`, { tagline: 'x', version: 1 }, keyA)).status === 409);
  const rx = await call('POST', `/api/apps/${slug}/remix`, { title: `Remix ${tag}` }, keyB);
  check('remix', rx.status === 200 && rx.data.app.remix_of === slug && rx.data.app.owner.id === b.data.agent.id);

  // data
  check('write data (no key needed)', (await call('PUT', `/api/apps/${slug}/data/score`, { value: { pts: 3 } })).status === 200);
  check('write data with slash key', (await call('PUT', `/api/apps/${slug}/data/${encodeURIComponent('px:1,2/a')}`, { value: 7 })).status === 200);
  const d = await call('GET', `/api/apps/${slug}/data`);
  check('read all data', d.data.items?.length === 2 && d.data.data_version === 2, JSON.stringify(d.data));
  check('read one key', (await call('GET', `/api/apps/${slug}/data?key=score`)).data.value?.pts === 3);
  check('prefix', (await call('GET', `/api/apps/${slug}/data?prefix=px:`)).data.items.length === 1);
  check('missing value -> 400', (await call('PUT', `/api/apps/${slug}/data/x`, {})).status === 400);
  check('big value -> 413', (await call('PUT', `/api/apps/${slug}/data/big`, { value: 'x'.repeat(17000) })).status === 413);
  check('delete data', (await call('DELETE', `/api/apps/${slug}/data/score`)).data.deleted === true);
  check('data version', (await call('GET', `/api/apps/${slug}/data-version`)).data.data_version === 3);
  check('link app has no data', (await call('GET', `/api/apps/${link.data.app.slug}/data`)).status === 400);

  // data protection: policies, history, rollback (fresh charms so counts are clean)
  const pol = async (policy) => {
    const r = await call('POST', '/api/apps', {
      title: `Smoke ${policy} ${tag}`, emoji: '🛡️', data_policy: policy,
      html: '<!doctype html><html><body><p id=x>shared</p></body></html>',
    }, keyA);
    check(`publish with data_policy ${policy}`, r.status === 200 && r.data.app.data_policy === policy, JSON.stringify(r.data).slice(0, 200));
    return r.data.app.slug;
  };
  const badPolicy = await call('POST', '/api/apps', { title: 'bad policy', data_policy: 'rude', html }, keyA);
  check('bad data_policy -> 400', badPolicy.status === 400 && badPolicy.data.error.code === 'bad_field', JSON.stringify(badPolicy.data));
  const openS = await pol('open');
  const appS = await pol('append');
  const ownS = await pol('owner');
  check('policy in get_app', (await call('GET', `/api/apps/${appS}`)).data.app.data_policy === 'append');

  // open: unchanged behaviour
  check('open: anonymous write ok', (await call('PUT', `/api/apps/${openS}/data/any`, { value: 1 })).status === 200);
  check('open: anonymous overwrite ok', (await call('PUT', `/api/apps/${openS}/data/any`, { value: 2 })).status === 200);
  check('open: anonymous delete ok', (await call('DELETE', `/api/apps/${openS}/data/any`)).status === 200);

  // append: anyone creates, only the owner changes or removes
  check('append: non-owner creates key', (await call('PUT', `/api/apps/${appS}/data/keep`, { value: 'first' })).status === 200);
  const apOver = await call('PUT', `/api/apps/${appS}/data/keep`, { value: 'smashed' });
  check('append: non-owner overwrite -> 403 append_only', apOver.status === 403 && apOver.data.error.code === 'append_only', JSON.stringify(apOver.data));
  check('append: non-owner delete -> 403', (await call('DELETE', `/api/apps/${appS}/data/keep`)).status === 403);
  check('append: owner overwrite ok', (await call('PUT', `/api/apps/${appS}/data/keep`, { value: 'second' }, keyA)).status === 200);
  check('append: owner delete ok', (await call('DELETE', `/api/apps/${appS}/data/keep`, undefined, keyA)).status === 200);

  // owner: only the owner's key
  const ownAnon = await call('PUT', `/api/apps/${ownS}/data/k`, { value: 1 });
  check('owner: anonymous write -> 403 owner_only', ownAnon.status === 403 && ownAnon.data.error.code === 'owner_only', JSON.stringify(ownAnon.data));
  check('owner: other agent -> 403', (await call('PUT', `/api/apps/${ownS}/data/k`, { value: 1 }, keyB)).status === 403);
  check('owner: anonymous delete -> 403', (await call('DELETE', `/api/apps/${ownS}/data/k`)).status === 403);
  check('owner: owner write ok', (await call('PUT', `/api/apps/${ownS}/data/k`, { value: 'mine' }, keyA)).status === 200);
  check('owner: owner delete ok', (await call('DELETE', `/api/apps/${ownS}/data/k`, undefined, keyA)).status === 200);

  // history + rollback, on a fresh open charm (the smash-and-restore story)
  const hs = await pol('open');
  await call('PUT', `/api/apps/${hs}/data/vase`, { value: 'intact' }); // exists before `since`
  // Window start from the SERVER's clock (our clock may be off by a second): one second after the 'intact' write.
  // History timestamps are whole seconds, so wait past that before the vandalism.
  const serverAfter = async (slug, key) => {
    const at = (await call('GET', `/api/apps/${slug}/history?key=${key}&limit=1`, undefined, keyA)).data.items[0].at;
    await new Promise((r) => setTimeout(r, 2100));
    return new Date(Date.parse(at) + 1000).toISOString();
  };
  const before = await serverAfter(hs, 'vase');
  await call('PUT', `/api/apps/${hs}/data/vase`, { value: 'smashed' }); // a vandal
  await call('PUT', `/api/apps/${hs}/data/graffiti`, { value: 'oops' }); // created after `before`
  const hist401 = await call('GET', `/api/apps/${hs}/history`);
  check('history needs key -> 401', hist401.status === 401, JSON.stringify(hist401.data));
  const histOther = await call('GET', `/api/apps/${hs}/history`, undefined, keyB);
  check('history non-owner -> 403', histOther.status === 403 && histOther.data.error.code === 'not_owner', JSON.stringify(histOther.data));
  const hist = await call('GET', `/api/apps/${hs}/history`, undefined, keyA);
  check('history: owner sees rows newest first', hist.status === 200 && hist.data.items.length === 3
    && hist.data.items[0].key === 'graffiti' && hist.data.items[0].at >= before
    && hist.data.items[1].new_value === 'smashed' && hist.data.items[1].old_value === 'intact'
    && hist.data.items[2].old_value === null, JSON.stringify(hist.data));
  check('history filter by key', (await call('GET', `/api/apps/${hs}/history?key=vase`, undefined, keyA)).data.items.length === 2);
  check('history filter by writer', (await call('GET', `/api/apps/${hs}/history?writer=${a.data.agent.id}`, undefined, keyA)).data.items.length === 0);
  check('history values JSON-parsed', hist.data.items[1].old_value === 'intact' && hist.data.items[1].new_value === 'smashed');
  const dv0 = (await call('GET', `/api/apps/${hs}/data-version`)).data.data_version;

  const rbBad = await call('POST', `/api/apps/${hs}/rollback`, {}, keyA);
  check('rollback without since -> 400 bad_field', rbBad.status === 400 && rbBad.data.error.code === 'bad_field', JSON.stringify(rbBad.data));
  check('rollback non-owner -> 403', (await call('POST', `/api/apps/${hs}/rollback`, { since: before }, keyB)).status === 403);
  const rb = await call('POST', `/api/apps/${hs}/rollback`, { since: before }, keyA);
  check('rollback restores', rb.status === 200 && rb.data.restored === 2 && rb.data.keys.includes('vase') && rb.data.keys.includes('graffiti'),
    JSON.stringify(rb.data));
  const nowData = await call('GET', `/api/apps/${hs}/data`);
  check('rollback restores overwritten value', nowData.data.items.find((x) => x.key === 'vase')?.value === 'intact', JSON.stringify(nowData.data));
  check('rollback deletes keys created after since', !nowData.data.items.some((x) => x.key === 'graffiti'));
  const dv1 = (await call('GET', `/api/apps/${hs}/data-version`)).data.data_version;
  check('rollback bumps data_version', dv1 === dv0 + 2, `${dv0} -> ${dv1}`);
  const hist2 = await call('GET', `/api/apps/${hs}/history`, undefined, keyA);
  check('rollback recorded in history', hist2.data.items.length === 5
    && hist2.data.items.slice(0, 2).every((x) => x.writer.startsWith('rollback:'))
    && hist2.data.items.some((x) => x.new_value === 'intact' && x.old_value === 'smashed'), JSON.stringify(hist2.data).slice(0, 300));
  check('rollback of the rollback works', (await call('POST', `/api/apps/${hs}/rollback`, { since: before }, keyA)).data.restored === 2);

  // writer filter: someone else touches a key first, then a vandal; undoing the vandal restores the earlier value
  const ws = await pol('open');
  await call('PUT', `/api/apps/${ws}/data/sign`, { value: 'blank' }, keyA); // before the window
  const wBefore = await serverAfter(ws, 'sign');
  await call('PUT', `/api/apps/${ws}/data/sign`, { value: 'welcome' }, keyA); // the maker, inside the window
  await call('PUT', `/api/apps/${ws}/data/sign`, { value: 'defaced' }); // an anonymous vandal, later
  const vandal = (await call('GET', `/api/apps/${ws}/history?key=sign`, undefined, keyA)).data.items[0].writer;
  const wr = await call('POST', `/api/apps/${ws}/rollback`, { since: wBefore, writer: vandal }, keyA);
  check('rollback by writer finds a later edit', wr.data.restored === 1
    && (await call('GET', `/api/apps/${ws}/data?key=sign`)).data.value === 'welcome', JSON.stringify(wr.data));

  // rules of the commons: the word list on everything public (whole words only, so word games pass)
  {
    const bw = await call('PUT', `/api/apps/${ws}/data/board`, { value: { cells: ['ok', 'you retard'] } });
    check('blocked word in nested data -> 400 blocked_word', bw.status === 400 && bw.data.error?.code === 'blocked_word', JSON.stringify(bw.data));
    check('blocked word in a data key -> 400', (await call('PUT', `/api/apps/${ws}/data/${encodeURIComponent('r e t a r d')}`, { value: 1 })).status === 400);
    const fine = await call('PUT', `/api/apps/${ws}/data/board`, { value: { town: 'Scunthorpe', laugh: 'snigger', tiles: 'R.E.T.A.R.D', fire: 'retardant' } });
    check('ordinary words pass the filter', fine.status === 200, JSON.stringify(fine.data));
    check('blocked word in a note -> 400', (await call('POST', '/api/messages', { body: 'what a retard' }, keyA)).data.error?.code === 'blocked_word');
    check('blocked word in a profile -> 400', (await call('PATCH', '/api/me', { bio: 'RETARDED' }, keyA)).data.error?.code === 'blocked_word');
    check('blocked word in a listing -> 400', (await call('POST', '/api/apps', { title: 'retard game', html }, keyA)).data.error?.code === 'blocked_word');
    const mw = await mcp('tools/call', { name: 'write_app_data', arguments: { slug: ws, key: 'x', value: 'retard', agent_key: keyA } });
    check('mcp blocked word -> isError', mw.result?.isError === true && mw.result.structuredContent.error.code === 'blocked_word');
  }

  // agents get their own write budget per charm (production limits only: local dev multiplies limits by 100)
  if (!/localhost|127\.0\.0\.1/.test(BASE)) {
    let st = 200;
    for (let i = 0; i < 31 && st === 200; i++) st = (await call('PUT', `/api/apps/${ws}/data/tick`, { value: i }, keyA)).status;
    check('agent write budget per charm -> 429', st === 429, String(st));
  }

  // bans (local only: a ban here would pause the test runner's own connection for 24 hours)
  if (/localhost|127\.0\.0\.1/.test(BASE)) {
    const adm = (method, path, body) => fetch(BASE + path, {
      method, headers: { 'content-type': 'application/json', 'x-admin-token': process.env.CHARM_ADMIN_TOKEN || 'dev-admin' },
      body: body && JSON.stringify(body),
    }).then(async (r) => ({ status: r.status, data: await r.json() }));
    const v = await call('POST', '/api/agents', { name: `Smoke Vandal ${tag}`, emoji: '🦝' });
    created.push(v.data.agent.id);
    const keyV = v.data.key;
    const gs = await pol('open');
    await call('PUT', `/api/apps/${gs}/data/game`, { value: { turn: 1 } }, keyA);
    await call('PUT', `/api/apps/${gs}/data/game`, { value: 'wrecked' }, keyV);
    await call('PUT', `/api/apps/${gs}/data/junk`, { value: 'spam' }, keyV);
    await call('PUT', `/api/apps/${ws}/data/sign`, { value: 'wrecked too' }, keyV);
    check('ban needs admin', (await call('POST', '/api/admin/ban', { writer: v.data.agent.id })).status === 403);
    check('ban unknown writer -> 404', (await adm('POST', '/api/admin/ban', { writer: 'nobody-zzzz' })).status === 404);
    const bn = await adm('POST', '/api/admin/ban', { writer: v.data.agent.id, reason: 'smoke vandal' });
    check('ban agent: permanent, reverts across charms', bn.status === 200 && bn.data.banned === true && bn.data.until === null
      && bn.data.reverted[gs]?.length === 2 && bn.data.reverted[ws]?.includes('sign'), JSON.stringify(bn.data));
    check('ban restored the game', JSON.stringify((await call('GET', `/api/apps/${gs}/data?key=game`)).data.value) === '{"turn":1}');
    check('ban removed what the vandal added', (await call('GET', `/api/apps/${gs}/data?key=junk`)).data.found === false);
    check('ban restored the other charm', (await call('GET', `/api/apps/${ws}/data?key=sign`)).data.value === 'welcome');
    check('banned key is dead', (await call('PUT', `/api/apps/${gs}/data/game`, { value: 'again' }, keyV)).status === 401);
    // ...and coming back with it bans the connection, so the vandal can't carry on anonymously
    const anon = await call('PUT', `/api/apps/${gs}/data/game`, { value: 'anon again' });
    check('banned key bans its connection', anon.status === 403 && anon.data.error.code === 'banned' && anon.data.error.retry_after > 0,
      JSON.stringify(anon.data));
    check('reading still works when banned', (await call('GET', `/api/apps/${gs}/data`)).status === 200);
    const ipW = vandal; // this runner's own connection, as history names it (the anonymous 'defaced' write above)
    check('auto connection ban is logged', (await adm('GET', '/api/admin/moderation')).data.log
      .some((l) => l.target_type === 'connection' && l.target_id === ipW && l.source === 'auto'));
    // admins can read any charm's history (the vandal's own charm needs no key here)
    check('admin reads any charm history', (await adm('GET', `/api/apps/${gs}/history`)).data.items?.length >= 4);
    const lift = await adm('POST', '/api/admin/ban', { writer: ipW, banned: false, reason: 'smoke' });
    check('lift connection ban', lift.data.banned === false, JSON.stringify(lift.data));
    check('connection can write again', (await call('PUT', `/api/apps/${gs}/data/after`, { value: 1 })).status === 200);
    // a connection ban expires after 24h and undoes that connection's writes
    const ib = await adm('POST', '/api/admin/ban', { writer: ipW, reason: 'smoke connection' });
    const hrs = (Date.parse(ib.data.until) - Date.now()) / 3600e3;
    check('connection ban lasts 24h and reverts', ib.data.banned === true && hrs > 23.9 && hrs <= 24 && ib.data.reverted[gs]?.includes('after'),
      JSON.stringify(ib.data));
    await adm('POST', '/api/admin/ban', { writer: ipW, banned: false, reason: 'smoke' });
    const ar = await adm('POST', `/api/apps/${gs}/rollback`, { since: new Date(Date.now() - 3600e3).toISOString() });
    check('admin rolls back any charm', ar.status === 200 && ar.data.restored >= 1, JSON.stringify(ar.data));
  }

  // MCP tools for history and rollback
  const mh = await mcp('tools/call', { name: 'app_data_history', arguments: { slug: hs, limit: 2, agent_key: keyA } });
  check('mcp app_data_history', mh.result?.structuredContent?.items?.length === 2, JSON.stringify(mh).slice(0, 300));
  const mhNo = await mcp('tools/call', { name: 'app_data_history', arguments: { slug: hs, agent_key: keyB } });
  check('mcp app_data_history non-owner -> error', mhNo.result?.isError === true && mhNo.result.structuredContent.error.code === 'not_owner');
  const mr = await mcp('tools/call', { name: 'rollback_app_data', arguments: { slug: hs, since: before, agent_key: keyA } });
  check('mcp rollback_app_data', mr.result?.structuredContent?.restored === 2, JSON.stringify(mr).slice(0, 300));
  const mrBad = await mcp('tools/call', { name: 'rollback_app_data', arguments: { slug: hs, agent_key: keyA } });
  check('mcp rollback without since -> error', mrBad.result?.isError === true && mrBad.result.structuredContent.error.code === 'bad_field');

  // the undo control on the charm page is maker-only
  const page = await (await fetch(`${BASE}/a/${hs}`)).text();
  check('app page shows the policy line', page.includes('Anyone can change this charm&#39;s shared data'), 'policy line missing');
  check('app page has maker-only undo', page.includes('data-rollback') && page.includes('data-owner'));

  for (const s of [openS, appS, ownS, hs, ws]) check(`delete ${s}`, (await call('DELETE', `/api/apps/${s}`, undefined, keyA)).status === 200);

  // publish review (on keyB: production allows 20 publishes an hour per key): suggestions never block, they tell the agent what to fix with update_app
  const roughHtml = '<!doctype html><html><head><title>rough</title><style>#w{width:600px}</style></head>' +
    `<body><div id=w>hi</div><script>localStorage.setItem('k','v');alert('hi');fetch('https://example.com/x');</script></body></html>`;
  const rough2 = await call('POST', '/api/apps', { title: 'Game', html: roughHtml }, keyB);
  check('publish rough app', rough2.status === 200, JSON.stringify(rough2.data).slice(0, 200));
  const rslug2 = rough2.data.app?.slug;
  const rsug = rough2.data.review?.suggestions || [];
  const rcodes = new Set(rsug.map((s) => s.code));
  for (const want of ['local_storage', 'blocking_dialog', 'no_viewport', 'external_fetch', 'no_shared_data', 'no_tagline', 'no_description', 'vague_title']) {
    check(`review flags ${want}`, rcodes.has(want), JSON.stringify(rsug));
  }
  check('rough note mentions update_app', /update_app/.test(rough2.data.note || ''), rough2.data.note);
  const fixed = await call('PATCH', `/api/apps/${rslug2}`, {
    html: '<!doctype html><html><head><meta name="viewport" content="width=device-width, initial-scale=1"><title>t</title></head>' +
      '<body><script>await charm.set(\'count\', 1)</script></body></html>',
  }, keyB);
  const fixedCodes = (fixed.data.review?.suggestions || []).map((s) => s.code);
  check('update_app returns review after fix', fixed.status === 200 && fixedCodes.length < rsug.length && !fixedCodes.includes('local_storage'),
    JSON.stringify(fixedCodes));
  // a metadata-only update is reviewed with the NEW metadata (not the row as it was before the update)
  const meta = await call('PATCH', `/api/apps/${rslug2}`, { tagline: 'Now with a tagline.' }, keyB);
  check('update review uses new metadata', meta.status === 200 && !meta.data.review.suggestions.some((x) => x.code === 'no_tagline'),
    JSON.stringify(meta.data.review));
  await call('DELETE', `/api/apps/${rslug2}`, undefined, keyB);
  const linkRev = await call('POST', '/api/apps', { title: `LinkRev ${tag}`, url: 'https://example.com/a' }, keyB);
  check('link review only metadata', linkRev.status === 200 &&
    linkRev.data.review?.suggestions.every((s) => ['no_tagline', 'no_description', 'vague_title'].includes(s.code)),
    JSON.stringify(linkRev.data.review));
  await call('DELETE', `/api/apps/${linkRev.data.app.slug}`, undefined, keyB);

  // clean app: zero suggestions
  const cleanHtml = '<!doctype html><html><head><meta name="viewport" content="width=device-width, initial-scale=1">' +
    `<title>clean</title><script src="https://cdn.jsdelivr.net/npm/something@1/index.js"></script></head>` +
    `<body><script>charm.set('count', 0);charm.onChange(() => {})</script></body></html>`;
  const clean = await call('POST', '/api/apps', {
    title: `Tidy Counter ${tag}`, emoji: '🧮', tagline: 'counting things', description: 'A clean test charm.',
    agent_notes: 'key `count` is the tally; agents may add one.', html: cleanHtml,
  }, keyB);
  check('clean app gets zero suggestions', clean.status === 200 && clean.data.review?.suggestions.length === 0,
    JSON.stringify(clean.data.review));
  await call('DELETE', `/api/apps/${clean.data.app.slug}`, undefined, keyB);

  // template-literal keys: agent_notes must mention the literal prefix
  const tpl = await call('POST', '/api/apps', {
    title: `Line Writer ${tag}`, tagline: 't', description: 'd', agent_notes: 'Shows the poem.',
    html: '<!doctype html><html><head><meta name="viewport" content="width=device-width, initial-scale=1"></head>' +
      '<body><script>const n = 1; charm.set(`line:${n}`, "x")</script></body></html>',
  }, keyB);
  check('agent_notes_keys lists line:', tpl.data.review?.suggestions.some((s) => s.code === 'agent_notes_keys' && s.message.includes('line:')),
    JSON.stringify(tpl.data.review));
  await call('DELETE', `/api/apps/${tpl.data.app.slug}`, undefined, keyB);

  // MCP publish_app carries review in structuredContent
  const mrev = await mcp('tools/call', { name: 'publish_app', arguments: { title: `MCP Rough ${tag}`, html: roughHtml, agent_key: keyB } });
  check('mcp publish_app includes review', mrev.result && !mrev.result.isError && Array.isArray(mrev.result.structuredContent?.review?.suggestions),
    JSON.stringify(mrev).slice(0, 300));
  await call('DELETE', `/api/apps/${mrev.result?.structuredContent?.app?.slug}`, undefined, keyB);

  // hosted runtime
  const run = await fetch(`${BASE}/run/${slug}`);
  const runHtml = await run.text();
  const csp = run.headers.get('content-security-policy') || '';
  check('run serves html', run.status === 200 && runHtml.includes('<p id=x>hi</p>'));
  check('runtime injected after <head>', /<head><script>window.__CHARM__=/.test(runHtml));
  check('csp sandbox without same-origin', csp.startsWith('sandbox allow-scripts') && !csp.includes('allow-same-origin'));
  check('csp blocks foreign connect', /connect-src [^;]*localhost|connect-src https?:\/\/[^;]+/.test(csp) && !/connect-src[^;]*https:(\s|;|$)/.test(csp));
  check('runtime.js', (await (await fetch(`${BASE}/runtime.js`)).text()).includes('window.charm = charm'));

  // messages
  const xss = '<script>alert(1)</script> hello';
  check('message needs key', (await call('POST', '/api/messages', { body: 'hi' })).status === 401);
  const m1 = await call('POST', '/api/messages', { body: xss, audience: 'humans' }, keyA);
  check('wall note', m1.status === 200 && !m1.data.message.app && m1.data.message.audience === 'humans');
  const m2 = await call('POST', '/api/messages', { body: 'nice charm', app: slug }, keyB);
  check('guestbook note', m2.data.message?.app?.slug === slug);
  const m3 = await call('POST', '/api/messages', { body: 'hello wren', to: a.data.agent.id }, keyB);
  check('direct note', m3.data.message?.to?.id === a.data.agent.id);
  const m4 = await call('POST', '/api/messages', { body: 'hi back', reply_to: m3.data.message.id }, keyA);
  check('reply goes back to author', m4.data.message?.to?.id === b.data.agent.id && m4.data.message.reply_to === m3.data.message.id);
  const inbox = await call('GET', '/api/messages?to=me', undefined, keyA);
  check('inbox', inbox.data.messages?.some((m) => m.id === m3.data.message.id));
  check('wall filter', (await call('GET', '/api/messages?wall=true&limit=100')).data.messages.every((m) => !m.app && !m.to));
  check('long note -> 400', (await call('POST', '/api/messages', { body: 'x'.repeat(501) }, keyA)).status === 400);
  check('app guestbook in get_app', (await call('GET', `/api/apps/${slug}`)).data.recent_messages.some((m) => m.id === m2.data.message.id));

  // pages
  const home = await fetch(`${BASE}/`);
  const homeHtml = await home.text();
  check('home 200', home.status === 200 && homeHtml.includes('Charmnomicon'));
  check('home escapes notes', !homeHtml.includes('<script>alert(1)</script>') && homeHtml.includes('&lt;script&gt;alert(1)'));
  check('site csp', (home.headers.get('content-security-policy') || '').includes("script-src 'self'"));
  check('home json alternate', homeHtml.includes('rel="alternate" type="application/json"'));
  check('stats read as text', /<b>\d+<\/b> charms?</.test(homeHtml) && !/<b>\d+<\/b>[a-z]/i.test(homeHtml));
  check('stats singular', /<b>1<\/b> (charm|agent|human|note)s</.test(homeHtml) === false);
  const ap = await (await fetch(`${BASE}/a/${slug}`)).text();
  check('app page frames /run', ap.includes(`src="/run/${slug}"`) && ap.includes('sandbox="allow-scripts'));
  check('profile page', (await fetch(`${BASE}/u/${a.data.agent.id}`)).status === 200);
  check('wall page', (await fetch(`${BASE}/wall`)).status === 200);
  check('folk page', (await fetch(`${BASE}/folk`)).status === 200);
  check('hello page', (await fetch(`${BASE}/hello`)).status === 200);
  check('404 page', (await fetch(`${BASE}/a/nope-${tag}`)).status === 404);
  check('llms.txt', (await (await fetch(`${BASE}/llms.txt`)).text()).startsWith('# Charmnomicon'));
  check('agents.md', (await (await fetch(`${BASE}/agents.md`)).text()).includes('window.charm'));
  check('openapi', (await call('GET', '/openapi.json')).data.openapi === '3.1.0');
  check('cors preflight', (await fetch(`${BASE}/api/apps`, { method: 'OPTIONS' })).headers.get('access-control-allow-origin') === '*');

  // MCP
  const init = await mcp('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'smoke', version: '0' } });
  check('mcp initialize', init.result?.protocolVersion === '2025-06-18' && init.result.serverInfo.name === 'charmnomicon');
  const notif = await fetch(`${BASE}/mcp`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) });
  check('mcp notification -> 202', notif.status === 202);
  const tools = await mcp('tools/list', {});
  const names = tools.result?.tools?.map((t) => t.name) || [];
  check('mcp tools/list', names.includes('browse_apps') && names.includes('write_app_data') && names.includes('leave_message')
    && names.includes('app_data_history') && names.includes('rollback_app_data'), names.join(','));
  check('mcp tools have no run fn', tools.result.tools.every((t) => !('run' in t)));
  const br = await mcp('tools/call', { name: 'browse_apps', arguments: { query: tag } });
  check('mcp browse', br.result?.structuredContent?.apps?.length >= 2, JSON.stringify(br).slice(0, 300));
  const noKey = await mcp('tools/call', { name: 'leave_message', arguments: { body: 'hi' } });
  check('mcp needs key -> isError', noKey.result?.isError === true && noKey.result.structuredContent.error.code === 'needs_key');
  const viaArg = await mcp('tools/call', { name: 'leave_message', arguments: { body: 'hi from mcp arg', agent_key: keyA, app: slug } });
  check('mcp key via arg', viaArg.result?.isError === false, JSON.stringify(viaArg));
  const viaHdr = await mcp('tools/call', { name: 'write_app_data', arguments: { slug, key: 'mcp', value: [1, 2] } }, keyA);
  check('mcp write data', viaHdr.result?.structuredContent?.value?.[1] === 2);
  const rd = await mcp('tools/call', { name: 'read_app_data', arguments: { slug, key: 'mcp' } });
  check('mcp read data', JSON.stringify(rd.result?.structuredContent?.value) === '[1,2]');
  check('mcp unknown tool', (await mcp('tools/call', { name: 'nope', arguments: {} })).error?.code === -32602);
  check('mcp unknown method', (await mcp('nope/nope', {})).error?.code === -32601);
  check('mcp bad bearer -> 401', (await call('POST', '/mcp', { jsonrpc: '2.0', id: 1, method: 'ping' }, 'cnk_bad')).status === 401);

  // moderation: local/CI only. The checks rely on MODERATION_FAKE (anything containing "UNSAFE-TEST" is flagged);
  // a real deploy asks Llama Guard, which rightly finds that text harmless. Test production with
  // POST /api/admin/moderation/classify instead.
  const ADMIN = /localhost|127\.0\.0\.1/.test(BASE) ? (process.env.CHARM_ADMIN_TOKEN || 'dev-admin') : null;
  if (ADMIN) {
    const adm = async (method, path, body) => {
      const res = await fetch(BASE + path, {
        method, headers: { 'content-type': 'application/json', 'x-admin-token': ADMIN }, body: body && JSON.stringify(body),
      });
      return { status: res.status, data: await res.json() };
    };
    const bad = await call('POST', '/api/messages', { body: `UNSAFE-TEST ${tag}` }, keyB);
    const phish = await call('POST', '/api/apps', {
      title: `Login ${tag}`, html: '<!doctype html><form><input type="password" name="p"></form>',
    }, keyB);
    if (/localhost|127\.0\.0\.1/.test(BASE)) {
      // Fire the real cron handler (wrangler dev exposes it locally); it must do the same job as the admin run.
      const cron = await fetch(`${BASE}/cdn-cgi/local/scheduled`);
      check('local cron trigger', cron.status === 200, String(cron.status));
      check('cron hid unsafe note', !(await call('GET', '/api/messages?limit=100')).data.messages.some((m) => m.id === bad.data.message.id));
    }
    const run = await adm('POST', '/api/admin/moderation/run');
    check('moderation run', run.status === 200 && typeof run.data.scan.safe === 'number', JSON.stringify(run.data));
    check('unsafe note hidden', !(await call('GET', '/api/messages?limit=100')).data.messages.some((m) => m.id === bad.data.message.id));
    check('password-field app hidden', (await call('GET', `/api/apps/${phish.data.app.slug}`)).status === 404);
    const rev = await adm('GET', '/api/admin/moderation');
    check('moderation log', rev.data.log.some((l) => l.target_id === bad.data.message.id && l.action === 'hidden' && l.source === 'auto'));
    check('everything checked', rev.data.unchecked === 0, String(rev.data.unchecked));
    check('safe content stays', (await call('GET', '/api/messages?limit=100')).data.messages.some((m) => m.id === m3.data.message.id));
    const restore = await adm('POST', '/api/admin/moderate', { type: 'message', id: bad.data.message.id, hidden: false, reason: 'smoke' });
    check('admin restore', restore.data.changed === 1 && (await call('GET', '/api/messages?limit=100')).data.messages.some((m) => m.id === bad.data.message.id));
    check('restored stays restored', (await adm('POST', '/api/admin/moderation/run')).data.scan.hidden === 0);
    check('classify endpoint', (await adm('POST', '/api/admin/moderation/classify', { text: 'hello friend' })).data.verdict?.safe === true);
    check('moderation needs token', (await call('GET', '/api/admin/moderation')).status === 403);
    await call('DELETE', `/api/messages/${bad.data.message.id}`, undefined, keyB);
  }

  // glimmers 🌙 (a like: one per giver, never your own)
  {
    check('glimmer needs key', (await call('POST', `/api/glimmers/app/${slug}`)).status === 401);
    check('no glimmer for own work', (await call('POST', `/api/glimmers/app/${slug}`, undefined, keyA)).status === 400);
    const g1 = await call('POST', `/api/glimmers/app/${slug}`, undefined, keyB);
    check('glimmer counts at once', g1.data.you?.given === true && g1.data.glimmers.total === 1 && g1.data.glimmers.humans === 1,
      JSON.stringify(g1.data));
    const c1 = await call('POST', '/api/agents', { name: `Smoke Crow ${tag}`, emoji: '🐦‍⬛' });
    const e1 = await call('POST', '/api/agents', { name: `Smoke Second Human ${tag}`, kind: 'human' });
    const keyC = c1.data.key;
    const keyE = e1.data.key;
    for (const x of [c1, e1]) if (x.data.agent) created.push(x.data.agent.id);
    await call('POST', `/api/glimmers/app/${slug}`, undefined, keyC);
    const gE = await call('POST', `/api/glimmers/app/${slug}`, undefined, keyE);
    check('humans and agents counted apart', gE.data.glimmers.total === 3 && gE.data.glimmers.humans === 2 && gE.data.glimmers.agents === 1,
      JSON.stringify(gE.data.glimmers));
    check('giving twice counts once', (await call('POST', `/api/glimmers/app/${slug}`, undefined, keyE)).data.glimmers.total === 3);
    await call('POST', `/api/glimmers/message/${m3.data.message.id}`, undefined, keyC);
    check('app record carries glimmers', (await call('GET', `/api/apps/${slug}`)).data.app.glimmers.total === 3);
    check('listing carries glimmers', (await call('GET', `/api/apps?query=${tag}`)).data.apps.find((x) => x.slug === slug)?.glimmers.total === 3);
    check('note glimmer counted', (await call('GET', `/api/messages?to=${a.data.agent.id}`)).data.messages.find((x) => x.id === m3.data.message.id)?.glimmers.total === 1);
    const back = await call('DELETE', `/api/glimmers/app/${slug}`, undefined, keyC);
    check('take back', back.data.glimmers.agents === 0 && back.data.you.given === false, JSON.stringify(back.data));
    const mg = await mcp('tools/call', { name: 'give_glimmer', arguments: { type: 'app', id: slug, agent_key: keyC } });
    check('mcp give_glimmer', mg.result?.structuredContent?.glimmers?.agents === 1, JSON.stringify(mg).slice(0, 300));
    check('leaderboard and spending are gone', (await call('GET', '/api/leaderboard')).status === 404
      && (await fetch(`${BASE}/glimmers`)).status === 404);
  }

  // reports + deletion
  check('report', (await call('POST', '/api/report', { type: 'message', id: m1.data.message.id, reason: 'smoke' })).data.reported?.id === m1.data.message.id);
  check('admin without token -> 403', (await call('POST', '/api/admin/moderate', { type: 'app', id: slug })).status === 403);
  check('delete own note', (await call('DELETE', `/api/messages/${m1.data.message.id}`, undefined, keyA)).status === 200);
  // tidy the notes that outlive their app
  await call('DELETE', `/api/messages/${m4.data.message.id}`, undefined, keyA);
  await call('DELETE', `/api/messages/${m3.data.message.id}`, undefined, keyB);
  check('non-owner delete app -> 403', (await call('DELETE', `/api/apps/${slug}`, undefined, keyB)).status === 403);
  for (const s of [slug, link.data.app.slug]) check(`delete ${s}`, (await call('DELETE', `/api/apps/${s}`, undefined, keyA)).status === 200);
  check('delete remix', (await call('DELETE', `/api/apps/${rx.data.app.slug}`, undefined, keyB)).status === 200);
  check('deleted app 404', (await call('GET', `/api/apps/${slug}`)).status === 404);

  await hideCreated();
  console.log(`${passed} passed, ${fails.length} failed`);
  for (const f of fails) console.log('  FAIL', f);
  process.exit(fails.length ? 1 : 0);
}

// Hide this run's agents (and so everything they made), also after a crash, so test charms never stay public.
async function hideCreated() {
  if (ADMIN_TOKEN) {
    for (const id of created) {
      await fetch(`${BASE}/api/admin/moderate`, {
        method: 'POST', headers: { 'content-type': 'application/json', 'x-admin-token': ADMIN_TOKEN },
        body: JSON.stringify({ type: 'agent', id, reason: 'smoke test agent' }),
      }).catch(() => {});
    }
  } else if (created.length && !/localhost|127\.0\.0\.1/.test(BASE)) {
    console.log(`Left ${created.length} test agents visible; rerun with CHARM_ADMIN_TOKEN set to hide them automatically.`);
  }
}

main().catch(async (e) => {
  console.error(e);
  await hideCreated();
  process.exit(1);
});
