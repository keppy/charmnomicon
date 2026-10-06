// Mobile layout check: loads every page type in headless Chrome emulating an iPhone and fails on
// horizontal overflow (anything wider than the screen). Usage: node scripts/mobile-check.mjs [base-url]
// Set MOBILE_SHOTS=<dir> to also save a full-page screenshot of each page. No dependencies.

import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const BASE = (process.argv[2] || process.env.CHARM_BASE || 'http://localhost:8787').replace(/\/$/, '');
const SHOTS = process.env.MOBILE_SHOTS;
const exe = [
  process.env.CHROME,
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
].filter(Boolean).find((p) => existsSync(p));
if (!exe) throw new Error('No Chrome/Edge found; set CHROME=/path/to/chrome');

// The narrowest phones still in common use, plus a current iPhone.
const DEVICES = [
  { name: 'iPhone 15', width: 393, height: 852 },
  { name: 'iPhone SE', width: 320, height: 568 },
  // what a phone shows before (or without) the web font: the fallback serif is wider than Fraunces
  { name: 'iPhone SE, no web fonts', width: 320, height: 568, noWebFonts: true },
];
const UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const profile = mkdtempSync(join(tmpdir(), 'charm-mobile-'));
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
ws.addEventListener('message', (e) => {
  const msg = JSON.parse(e.data);
  if (msg.id && pending.has(msg.id)) {
    const { resolve, reject } = pending.get(msg.id);
    pending.delete(msg.id);
    msg.error ? reject(new Error(JSON.stringify(msg.error))) : resolve(msg.result);
  }
});
const send = (method, params = {}, sessionId) => new Promise((resolve, reject) => {
  const id = ++nextId;
  pending.set(id, { resolve, reject });
  ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
});
const { targetId } = await send('Target.createTarget', { url: 'about:blank' });
const { sessionId } = await send('Target.attachToTarget', { targetId, flatten: true });
const cmd = (m, p) => send(m, p, sessionId);
const ev = async (expression) => (await cmd('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })).result.value;
await cmd('Page.enable');
await cmd('Runtime.enable');
await cmd('Network.enable');

// Pick real ids for the parameterised pages.
const apps = await (await fetch(`${BASE}/api/apps?limit=1`)).json();
const folk = await (await fetch(`${BASE}/api/agents?limit=1`)).json();
const PAGES = ['/', '/wall', '/folk', '/glimmers', '/hello', '/bring', '/no-such-page'];
if (apps.apps?.[0]) PAGES.push(`/a/${apps.apps[0].slug}`);
if (folk.agents?.[0]) PAGES.push(`/u/${folk.agents[0].id}`);

// Elements whose right edge passes the viewport, outermost first (children of an offender are skipped).
const OVERFLOW = `(() => {
  const vw = document.documentElement.clientWidth;
  const out = [];
  for (const el of document.querySelectorAll('body *')) {
    const r = el.getBoundingClientRect();
    if (!r.width || r.right <= vw + 1) continue;
    let p = el.parentElement, clipped = false;
    while (p && p !== document.body) {
      const cs = getComputedStyle(p);
      if (/(auto|scroll|hidden|clip)/.test(cs.overflowX) && p.getBoundingClientRect().right <= vw + 1) { clipped = true; break; }
      p = p.parentElement;
    }
    if (clipped || out.some((o) => o.el.contains(el))) continue;
    out.push({ el, d: el.tagName.toLowerCase() + (el.className && typeof el.className === 'string' ? '.' + el.className.trim().split(/\\s+/).join('.') : '') + ' right=' + Math.round(r.right) });
  }
  return { vw, scroll: document.documentElement.scrollWidth, offenders: out.slice(0, 6).map((o) => o.d) };
})()`;

let passed = 0;
const fails = [];
try {
  for (const d of DEVICES) {
    await cmd('Emulation.setDeviceMetricsOverride', { width: d.width, height: d.height, deviceScaleFactor: 3, mobile: true });
    await cmd('Emulation.setUserAgentOverride', { userAgent: UA, platform: 'iPhone' });
    await cmd('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });
    await cmd('Network.setBlockedURLs', { urls: d.noWebFonts ? ['*fonts.googleapis.com*', '*fonts.gstatic.com*'] : [] });
    for (const path of PAGES) {
      await cmd('Page.navigate', { url: BASE + path });
      for (let i = 0; i < 50 && (await ev('document.readyState')) !== 'complete'; i++) await sleep(150);
      await ev('Promise.race([document.fonts.ready, new Promise((r) => setTimeout(r, 4000))]).then(() => true)');
      await sleep(300);
      const r = await ev(OVERFLOW);
      const head = await ev(`(() => {
        const b = document.querySelector('.brand'), c = document.querySelector('header .me-chip');
        if (!b || !c) return 'ok';
        const br = b.getBoundingClientRect(), cr = c.getBoundingClientRect();
        if (b.scrollWidth > b.clientWidth + 1) return 'logo text clipped';
        const sameRow = Math.abs(br.top - cr.top) < br.height;
        return sameRow && br.right > cr.left - 4 ? 'logo runs into Say hello' : 'ok';
      })()`);
      if (head !== 'ok') r.offenders.unshift(head);
      if (r.scroll <= r.vw + 1 && !r.offenders.length) passed++;
      else fails.push(`${d.name} ${path}: page ${r.scroll}px wide on a ${r.vw}px screen; ${r.offenders.join(', ')}`);
      if (SHOTS) {
        const { data } = await cmd('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true });
        writeFileSync(join(SHOTS, `mobile-${d.width}${d.noWebFonts ? '-nofonts' : ''}${path === '/' ? '_home' : path.replace(/[^a-z0-9]+/gi, '_')}.png`), Buffer.from(data, 'base64'));
      }
    }
  }
} finally {
  ws.close();
  proc.kill();
  await sleep(300);
  try { rmSync(profile, { recursive: true, force: true }); } catch { /* browser may still hold files */ }
}
console.log(`${passed} passed, ${fails.length} failed`);
for (const f of fails) console.log(`  FAIL ${f}`);
process.exitCode = fails.length ? 1 : 0;
