// End-to-end smoke test against a running instance (local `npm run dev` or a deploy).
// Usage: node scripts/smoke.mjs [base-url]
// Exercises every surface: JSON API, hosted runtime + CSP, HTML pages, MCP, and the failure paths.

const BASE = (process.argv[2] || process.env.CHARM_BASE || 'http://localhost:8787').replace(/\/$/, '');
let passed = 0;
const fails = [];
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
  check('register agent', a.status === 200 && a.data.key?.startsWith('cnk_'), JSON.stringify(a.data));
  const keyA = a.data.key;
  const b = await call('POST', '/api/agents', { name: `Smoke Human ${tag}`, kind: 'human' });
  check('register human', b.status === 200 && b.data.agent.kind === 'human');
  const keyB = b.data.key;
  check('whoami', (await call('GET', '/api/me', undefined, keyA)).data.agent?.id === a.data.agent.id);
  check('bad key -> 401', (await call('GET', '/api/me', undefined, 'cnk_nope')).status === 401);
  check('empty name -> 400', (await call('POST', '/api/agents', { name: '' })).status === 400);

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
  check('mcp tools/list', names.includes('browse_apps') && names.includes('write_app_data') && names.includes('leave_message'), names.join(','));
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

  // reports + deletion
  check('report', (await call('POST', '/api/report', { type: 'message', id: m1.data.message.id, reason: 'smoke' })).data.reported?.id === m1.data.message.id);
  check('admin without token -> 403', (await call('POST', '/api/admin/moderate', { type: 'app', id: slug })).status === 403);
  check('delete own note', (await call('DELETE', `/api/messages/${m1.data.message.id}`, undefined, keyA)).status === 200);
  check('non-owner delete app -> 403', (await call('DELETE', `/api/apps/${slug}`, undefined, keyB)).status === 403);
  for (const s of [slug, link.data.app.slug]) check(`delete ${s}`, (await call('DELETE', `/api/apps/${s}`, undefined, keyA)).status === 200);
  check('delete remix', (await call('DELETE', `/api/apps/${rx.data.app.slug}`, undefined, keyB)).status === 200);
  check('deleted app 404', (await call('GET', `/api/apps/${slug}`)).status === 404);

  console.log(`${passed} passed, ${fails.length} failed`);
  for (const f of fails) console.log('  FAIL', f);
  process.exit(fails.length ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
