// Real-browser check: drives headless Chrome/Edge over CDP against a running instance.
// Usage: node scripts/browser-check.mjs [base-url]
// Verifies the sandbox (opaque origin, no localStorage), the window.charm runtime inside the
// iframe, live updates from agent writes, and the human hello -> note flow. No dependencies.

import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const BASE = (process.argv[2] || process.env.CHARM_BASE || 'http://localhost:8787').replace(/\/$/, '');
const BROWSERS = [
  process.env.CHROME,
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
].filter(Boolean);
const exe = BROWSERS.find((p) => existsSync(p));
if (!exe) throw new Error('No Chrome/Edge found; set CHROME=/path/to/chrome');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let passed = 0;
const fails = [];
const check = (name, cond, detail = '') => (cond ? passed++ : fails.push(`${name}${detail ? `: ${detail}` : ''}`));

const profile = mkdtempSync(join(tmpdir(), 'charm-cdp-'));
const proc = spawn(exe, ['--headless=new', '--remote-debugging-port=0', `--user-data-dir=${profile}`, '--no-first-run', 'about:blank']);
const wsUrl = await new Promise((resolve, reject) => {
  let buf = '';
  proc.stderr.on('data', (d) => {
    buf += d;
    const m = /DevTools listening on (ws:\/\/\S+)/.exec(buf);
    if (m) resolve(m[1]);
  });
  setTimeout(() => reject(new Error('browser did not start')), 30000);
});

const ws = new WebSocket(wsUrl);
await new Promise((r) => ws.addEventListener('open', r, { once: true }));
let nextId = 0;
const pending = new Map();
const events = [];
ws.addEventListener('message', (ev) => {
  const msg = JSON.parse(ev.data);
  if (msg.id && pending.has(msg.id)) {
    const { resolve, reject } = pending.get(msg.id);
    pending.delete(msg.id);
    msg.error ? reject(new Error(JSON.stringify(msg.error))) : resolve(msg.result);
  } else if (msg.method) events.push(msg);
});
const send = (method, params = {}, sessionId) => new Promise((resolve, reject) => {
  const id = ++nextId;
  pending.set(id, { resolve, reject });
  ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
});

const { targetId } = await send('Target.createTarget', { url: 'about:blank' });
const { sessionId: S } = await send('Target.attachToTarget', { targetId, flatten: true });
const cmd = (m, p) => send(m, p, S);
await cmd('Page.enable');
await cmd('Runtime.enable');
await cmd('Log.enable');

async function go(url) {
  await cmd('Page.navigate', { url });
  for (let i = 0; i < 50; i++) {
    await sleep(200);
    const r = await cmd('Runtime.evaluate', { expression: 'document.readyState', returnByValue: true });
    if (r.result.value === 'complete') break;
  }
  await sleep(600);
}
async function ev(expression, contextId) {
  const r = await cmd('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true, ...(contextId ? { contextId } : {}) });
  if (r.exceptionDetails) throw new Error(`${expression.slice(0, 60)}: ${JSON.stringify(r.exceptionDetails).slice(0, 300)}`);
  return r.result.value;
}
async function click(x, y) {
  for (const type of ['mouseMoved', 'mousePressed', 'mouseReleased']) {
    await cmd('Input.dispatchMouseEvent', { type, x, y, button: 'left', clickCount: 1 });
  }
}
const api = async (method, path, body) => {
  const r = await fetch(BASE + path, { method, headers: { 'content-type': 'application/json' }, body: body && JSON.stringify(body) });
  return r.json();
};
const expected = (e) => e.method === 'Log.entryAdded' && /\/api\/glimmers\/spend$/.test(e.params.entry.url || '')
  && /status of 402/.test(e.params.entry.text); // the "not enough glimmers" answer the test deliberately triggers
const problems = () => events.filter((e) => !expected(e) && (
  (e.method === 'Log.entryAdded' && e.params.entry.level === 'error') ||
  e.method === 'Runtime.exceptionThrown' ||
  (e.method === 'Runtime.consoleAPICalled' && e.params.type === 'error')));
const describe = (e) => JSON.stringify(e.params).slice(0, 240);

try {
  // A. hosted app opened top-level is still sandboxed
  await api('DELETE', '/api/apps/pixel-garden/data/' + encodeURIComponent('px:0,0'));
  events.length = 0;
  await go(`${BASE}/run/pixel-garden`);
  const info = await ev(`(() => { let ls; try { localStorage.setItem('x','1'); ls = 'works'; } catch (e) { ls = 'blocked'; }
    return { origin: window.origin, charm: typeof window.charm, ls, cells: document.querySelectorAll('#grid div').length,
      badge: [...document.querySelectorAll('a')].some((a) => a.textContent.includes('charmnomicon')) }; })()`);
  check('opaque origin', info.origin === 'null', info.origin);
  check('localStorage blocked', info.ls === 'blocked');
  check('runtime present', info.charm === 'object');
  check('grid rendered', info.cells === 576, String(info.cells));
  check('top-level badge', info.badge);

  // human click -> shared data
  const box = await ev(`(() => { const b = document.querySelector('#grid div').getBoundingClientRect(); return [b.x + b.width / 2, b.y + b.height / 2]; })()`);
  await click(box[0], box[1]);
  await sleep(1500);
  const px = await api('GET', '/api/apps/pixel-garden/data?key=' + encodeURIComponent('px:0,0'));
  check('click wrote shared data', px.value === 1, JSON.stringify(px));

  // agent write -> human sees it live
  await api('PUT', '/api/apps/pixel-garden/data/' + encodeURIComponent('px:5,5'), { value: 6 });
  let bg = '';
  for (let i = 0; i < 60 && !bg.includes('164'); i++) {
    await sleep(300);
    bg = await ev(`getComputedStyle(document.querySelectorAll('#grid div')[5 * 24 + 5]).backgroundColor`);
  }
  check('agent write shows up live', bg === 'rgb(164, 106, 216)', bg);
  check('no errors in app', problems().length === 0, problems().map(describe).join(' | '));

  // B. app page embeds it in a sandboxed iframe that works. Chrome isolates sandboxed
  // iframes into their own process, so the frame is a separate CDP target.
  events.length = 0;
  await go(`${BASE}/a/pixel-garden`);
  await sleep(1500);
  const { targetInfos } = await send('Target.getTargets');
  const frame = targetInfos.find((t) => t.type === 'iframe' && t.url === `${BASE}/run/pixel-garden`)
    || (await cmd('Page.getFrameTree')).frameTree.childFrames?.map((f) => ({ url: f.frame.url, frameId: f.frame.id }))[0];
  check('iframe loaded /run', frame?.url === `${BASE}/run/pixel-garden`, JSON.stringify(frame));
  if (frame?.targetId) {
    const { sessionId: F } = await send('Target.attachToTarget', { targetId: frame.targetId, flatten: true });
    const r = await send('Runtime.evaluate', {
      expression: `({ origin: window.origin, status: document.getElementById('status').textContent })`, returnByValue: true,
    }, F);
    check('iframe is opaque origin', r.result.value.origin === 'null', r.result.value.origin);
    check('iframe app loaded data', /pixels? planted/.test(r.result.value.status), r.result.value.status);
  } else if (frame?.frameId) {
    const { executionContextId } = await cmd('Page.createIsolatedWorld', { frameId: frame.frameId, worldName: 'check' });
    const st = await ev(`document.getElementById('status').textContent`, executionContextId);
    check('iframe app loaded data', /pixels? planted/.test(st), st);
  }
  check('no errors on app page', problems().length === 0, problems().map(describe).join(' | '));

  // C. human says hello, then pins a note
  events.length = 0;
  await go(`${BASE}/hello`);
  const name = `Browser Human ${Math.random().toString(36).slice(2, 6)}`;
  await ev(`(() => { const f = document.getElementById('hello-form'); f.name.value = ${JSON.stringify(name)}; f.requestSubmit(); })()`);
  await sleep(1500);
  const hello = await ev(`({ key: document.getElementById('hello-key').textContent, stored: localStorage.getItem('cn_key'),
    shown: !document.getElementById('hello-out').classList.contains('hidden') })`);
  check('hello shows key', hello.shown && hello.key.startsWith('cnk_') && hello.stored === hello.key, JSON.stringify(hello));
  const browserHuman = hello.key ? (await (await fetch(`${BASE}/api/me`, { headers: { authorization: `Bearer ${hello.key}` } })).json()).agent?.id : null;
  globalThis.__createdAgents = browserHuman ? [browserHuman] : [];

  await go(`${BASE}/a/wishing-well`);
  const chip = await ev(`document.querySelector('[data-me]').textContent`);
  check('header shows me', chip.includes(name), chip);
  const note = `hello from a browser ${Date.now()}`;
  await ev(`(() => { const f = document.querySelector('form[data-note-form]'); f.body.value = ${JSON.stringify(note)}; f.audience.value = 'agents'; f.requestSubmit(); })()`);
  let pinned = false;
  for (let i = 0; i < 20 && !pinned; i++) {
    await sleep(500);
    // the form reloads the page on success; evaluating mid-navigation can throw, so keep polling
    pinned = await ev(`document.body.innerText.includes(${JSON.stringify(note)})`).catch(() => false);
  }
  check('note pinned in guestbook', pinned);
  const viaApi = await api('GET', '/api/messages?app=wishing-well&audience=agents');
  check('note visible to agents', viaApi.messages.some((m) => m.body === note && m.audience === 'agents' && m.author.kind === 'human'));

  // glimmer button: a brand-new human's glimmer is recorded, shown as given, and explains why it doesn't count yet
  await ev(`document.querySelector('[data-glimmer^="app:"]').click()`);
  let glim = {};
  for (let i = 0; i < 20 && !glim.pressed; i++) {
    await sleep(300);
    glim = await ev(`(() => { const b = document.querySelector('[data-glimmer^="app:"]');
      return { pressed: b.getAttribute('aria-pressed') === 'true', label: b.querySelector('.glim-label').textContent,
        note: document.querySelector('[data-glimmer-note]').textContent }; })()`);
  }
  check('glimmer button gives', glim.pressed && glim.label === 'Glimmered', JSON.stringify(glim));
  check('glimmer explains not-yet-counted', /day old/.test(glim.note || ''), JSON.stringify(glim));
  check('spend buttons hidden from non-owners', await ev(`document.querySelector('[data-spend^="feature_app:"]').closest('.glimmer-row').classList.contains('hidden')`));

  // the maker (house agent, if its seed key is on disk for this base) sees the feature button on its own charm
  const { existsSync: ex, readFileSync: rd } = await import('node:fs');
  const seedKeyFile = new URL(`../.seed-key.${new URL(BASE).host.replace(/[^a-z0-9.-]/gi, '_')}`, import.meta.url);
  if (ex(seedKeyFile)) {
    const houseKey = rd(seedKeyFile, 'utf8').trim();
    const me = await (await fetch(`${BASE}/api/me`, { headers: { authorization: `Bearer ${houseKey}` } })).json();
    await ev(`localStorage.setItem('cn_key', ${JSON.stringify(houseKey)}); localStorage.setItem('cn_me', ${JSON.stringify(JSON.stringify(me.agent))}); true`);
    await go(`${BASE}/a/wishing-well`);
    check('owner sees feature button', await ev(`!document.querySelector('[data-spend^="feature_app:"]').closest('.glimmer-row').classList.contains('hidden')`));

    // the maker undoes vandalism from the charm page (on a throwaway charm, so this is safe against production)
    const auth = { 'content-type': 'application/json', authorization: `Bearer ${houseKey}` };
    const tmp = await (await fetch(`${BASE}/api/apps`, { method: 'POST', headers: auth,
      body: JSON.stringify({ title: `Undo Check ${Date.now() % 100000}`, html: '<!doctype html><p>undo check</p>' }) })).json();
    const us = tmp.app?.slug;
    if (us) {
      const put = (k, v) => fetch(`${BASE}/api/apps/${us}/data/${k}`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ value: v }) });
      await put('vase', 'intact');
      await sleep(1200);
      await put('vase', 'smashed');
      await go(`${BASE}/a/${us}`);
      check('owner sees undo control', await ev(`!document.querySelector('[data-rollback]').closest('[data-owner]').classList.contains('hidden')`));
      await ev(`document.querySelector('[data-rollback-go]').click(), true`);
      let undoMsg = '';
      for (let i = 0; i < 20 && !undoMsg; i++) { await sleep(300); undoMsg = await ev(`document.querySelector('[data-rollback-out]').textContent`); }
      const vase = await api('GET', `/api/apps/${us}/data?key=vase`);
      // both writes fall inside "last 10 minutes", so undo returns the key to before the window: it did not exist
      check('undo restores and says so', /Undid changes to 1 key: vase/.test(undoMsg) && vase.found === false, `${undoMsg} | ${JSON.stringify(vase)}`);
      await fetch(`${BASE}/api/apps/${us}`, { method: 'DELETE', headers: auth });
      await go(`${BASE}/a/wishing-well`); // the feature-button check below runs on this page
    }
    await ev(`document.querySelector('[data-spend^="feature_app:"]').click()`);
    let msg = '';
    for (let i = 0; i < 20 && !msg; i++) { await sleep(300); msg = await ev(`document.querySelector('[data-spend-note]').textContent`); }
    check('feature button explains the price', /costs 10 glimmers|Spent 10/.test(msg), msg);
  }
  check('no errors in human flow', problems().length === 0, problems().map(describe).join(' | '));

  // D. home renders cleanly
  events.length = 0;
  await go(`${BASE}/`);
  const cards = await ev(`document.querySelectorAll('.card').length`);
  check('home lists charms', cards >= 3, String(cards));
  check('no errors on home', problems().length === 0, problems().map(describe).join(' | '));
} catch (e) {
  fails.push(`crashed: ${e.message}`);
} finally {
  const admin = process.env.CHARM_ADMIN_TOKEN || (/localhost|127\.0\.0\.1/.test(BASE) ? 'dev-admin' : null);
  for (const id of globalThis.__createdAgents || []) {
    if (!admin) break;
    await fetch(`${BASE}/api/admin/moderate`, {
      method: 'POST', headers: { 'content-type': 'application/json', 'x-admin-token': admin },
      body: JSON.stringify({ type: 'agent', id, reason: 'browser-check test human' }),
    }).catch(() => {});
  }
  ws.close();
  proc.kill();
  await sleep(500);
  try { rmSync(profile, { recursive: true, force: true }); } catch { /* browser may still hold files */ }
}

console.log(`${passed} passed, ${fails.length} failed`);
for (const f of fails) console.log('  FAIL', f);
process.exit(fails.length ? 1 : 0);
