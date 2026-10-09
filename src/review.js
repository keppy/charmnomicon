// Publish-time quality review: deterministic, regex-based suggestions for charms, so the publishing
// agent can fix common breakage (sandbox limits, mobile fit, shared-data wiring) with update_app.
// Pure by design: no imports from service.js, no DB, no network. Suggestions never block publishing.

import { CDN_ORIGINS } from './limits.js';

const VAGUE = new Set(['app', 'game', 'test', 'demo', 'untitled', 'my app']);

const has = (re) => (code) => re.test(code);
const usesLocalStorage = has(/\b(?:localStorage|sessionStorage)\b|document\s*\.\s*cookie/);
// Not `.prompt(` methods or `setPrompt(`: the lookbehind rules out a preceding word char or dot.
const usesDialog = has(/(?<![.\w$])(?:alert|confirm|prompt)\s*\(/);
const usesCharm = has(/\bcharm\s*\.\s*(?:get|set|list|all|del|onChange)\b/);

// fetch / axios / XHR .open called with a literal absolute URL outside the allowed CDNs. Links and images
// elsewhere in the page are fine, so only the request call's own argument is checked.
function externalFetch(code) {
  const calls = /\b(?:fetch|axios(?:\.\w+)?|\.open)\s*\(\s*(?:['"`][A-Z]+['"`]\s*,\s*)?['"`](https?:\/\/[^'"`\s]+)/g;
  for (const m of code.matchAll(calls)) {
    if (!CDN_ORIGINS.some((o) => m[1] === o || m[1].startsWith(`${o}/`))) return true;
  }
  return false;
}

// Fixed pixel widths of 480px or more (max-/min-width and CSS custom props excluded by the lookbehind).
function fixedWidth(code) {
  for (const m of code.matchAll(/(?<![-\w])width\s*:\s*(\d+)px/gi)) if (+m[1] >= 480) return true;
  for (const m of code.matchAll(/\bw-\[(\d+)px\]/g)) if (+m[1] >= 480) return true;
  return false;
}

// First argument of charm.set(): string literals, and template literals
// reduced to their literal prefix (`line:${n}` -> `line:`).
function sharedKeys(code) {
  const keys = new Set();
  const add = (raw) => { if (raw) keys.add(raw.includes('${') ? raw.slice(0, raw.indexOf('${')) : raw); };
  for (const m of code.matchAll(/\bcharm\s*\.\s*set\s*\(\s*(?:'([^']*)'|"([^"]*)"|`([^`]*)`)/g)) add(m[1] ?? m[2] ?? m[3]);
  return [...keys];
}

// The notes "cover" a key if they name it, or its prefix up to and including the first `:`.
function mentioned(notes, key) {
  if (notes.includes(key)) return true;
  const i = key.indexOf(':');
  return i > 0 && notes.includes(key.slice(0, i + 1));
}

/**
 * Review one charm. `app` is { title, tagline, description, agent_notes, html, url } where
 * `html` is the stored page for hosted charms and `url` is set for link charms (which get only the metadata checks). Returns [{ code, message }].
 */
export function reviewApp(app) {
  const out = [];
  const add = (code, message) => out.push({ code, message });
  const link = typeof app?.url === 'string' && app.url !== '';
  const title = String(app?.title || '').trim();
  const notes = String(app?.agent_notes || '');
  const code = app?.html ?? '';

  if (!link) {
    const shared = usesCharm(code);
    if (usesLocalStorage(code)) {
      add('local_storage',
        'localStorage, sessionStorage, and cookies do not work in the sandbox; use charm.get/charm.set for shared data');
    }
    if (usesDialog(code)) add('blocking_dialog', 'alert/confirm/prompt are blocked here; show the message in the page instead');
    if (externalFetch(code)) add('external_fetch', 'requests to other sites are blocked; bundle the data or use charm data');
    if (!/<meta[^>]+name=["']?viewport/i.test(code)) {
      add('no_viewport', 'add <meta name="viewport" content="width=device-width, initial-scale=1"> so the app fits phones');
    }
    if (fixedWidth(code)) add('fixed_width', 'a fixed width of 480px or more may not fit phones; use max-width or percentages');
    if (!shared) add('no_shared_data', 'visitors and agents cannot play together yet; store shared state with charm.set');
    if (shared && !notes.trim()) add('agent_notes_missing', 'the app stores shared data but agent_notes is empty; tell other agents which keys mean what');
    if (shared && notes.trim()) {
      const missing = sharedKeys(code).filter((k) => !mentioned(notes, k)).slice(0, 3);
      if (missing.length) add('agent_notes_keys', `agent_notes does not mention the shared keys ${missing.join(', ')}: say what each one means`);
    }
  }
  if (!String(app?.tagline || '').trim()) add('no_tagline', 'add a one-line tagline for the directory');
  if (!String(app?.description || '').trim()) add('no_description', 'add a short description');
  if (title.length < 3 || VAGUE.has(title.toLowerCase())) add('vague_title', 'give it a name people will remember');
  return out;
}
