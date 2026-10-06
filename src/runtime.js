// The tiny runtime every hosted app gets as `window.charm`.
// It is served from /runtime.js and loaded before the app's own scripts.

export const RUNTIME_JS = `(() => {
  const cfg = window.__CHARM__ || {};
  const base = cfg.origin + '/api/apps/' + encodeURIComponent(cfg.app);
  async function call(method, path, body) {
    const res = await fetch(base + path, {
      method,
      headers: body === undefined ? {} : { 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      const err = new Error((data.error && data.error.message) || ('HTTP ' + res.status));
      err.code = data.error && data.error.code;
      err.status = res.status;
      throw err;
    }
    return data;
  }
  const k = (key) => '/data/' + encodeURIComponent(key);
  const charm = {
    app: cfg.app,
    origin: cfg.origin,
    pageUrl: cfg.origin + '/a/' + cfg.app,
    async get(key) { return (await call('GET', '/data?key=' + encodeURIComponent(key))).value; },
    async set(key, value) { return (await call('PUT', k(key), { value })).value; },
    async del(key) { await call('DELETE', k(key)); },
    async list(prefix) {
      return (await call('GET', '/data' + (prefix ? '?prefix=' + encodeURIComponent(prefix) : ''))).items;
    },
    async all(prefix) {
      const out = {};
      for (const it of await charm.list(prefix)) out[it.key] = it.value;
      return out;
    },
    async info() { return call('GET', ''); },
    async messages() { return (await call('GET', '').then((r) => r.recent_messages)); },
    onChange(cb, ms) {
      // Poll a cheap version counter. Back off while nothing changes (up to 15s) and snap back
      // to the base interval on any change, so idle tabs cost little and active ones stay live.
      const base = Math.max(1000, ms || 2500);
      let wait = base;
      let last = null;
      let stopped = false;
      let timer = null;
      let busy = false;
      const tick = async () => {
        if (stopped || busy) return;
        busy = true;
        if (!document.hidden) {
          try {
            const v = (await call('GET', '/data-version')).data_version;
            if (last !== null && v !== last) { cb(v); wait = base; } else { wait = Math.min(15000, wait * 1.5); }
            last = v;
          } catch (e) { wait = Math.min(15000, wait * 2); /* offline or rate limited */ }
        }
        busy = false;
        timer = setTimeout(tick, wait);
      };
      tick();
      // Interaction means someone is here: poll at the base rate again, starting now-ish.
      const poke = () => {
        if (wait === base) return;
        wait = base;
        clearTimeout(timer);
        timer = setTimeout(tick, base);
      };
      addEventListener('pointerdown', poke);
      addEventListener('keydown', poke);
      return () => { stopped = true; clearTimeout(timer); removeEventListener('pointerdown', poke); removeEventListener('keydown', poke); };
    },
  };
  window.charm = charm;
  if (window.top === window.self) {
    addEventListener('DOMContentLoaded', () => {
      const a = document.createElement('a');
      a.href = charm.pageUrl;
      a.target = '_top';
      a.textContent = '🔮 charmnomicon';
      a.setAttribute('style', 'position:fixed;right:10px;bottom:10px;z-index:2147483647;font:600 12px/1 system-ui,sans-serif;' +
        'padding:7px 10px;border-radius:999px;background:#2b2140;color:#f6efe1;text-decoration:none;opacity:.85;box-shadow:0 2px 8px #0003');
      document.body.appendChild(a);
    });
  }
})();
`;
