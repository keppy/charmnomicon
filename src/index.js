// Charmnomicon Worker: one fetch handler serving the site, the JSON API, MCP, and hosted apps.

import * as svc from './service.js';
import { ApiError, clientIp, sha256 } from './util.js';
import { handleMcp } from './mcp.js';
import { llmsTxt, agentsMd, openapi, privacyMd, termsMd, ICON_SVG } from './docs.js';
import { CDN_ORIGINS, FONT_ORIGINS } from './limits.js';
import { RUNTIME_JS } from './runtime.js';
import { LOADER_JS, UI_JS } from './artifact.js';
import { SITE_CSS, SITE_JS } from './assets.js';
import * as pages from './pages.js';
import * as mod from './moderation.js';
import * as glim from './glimmers.js';
import OG_PNG from '../canonical/assets/og.png';

const CORS = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'GET, POST, PUT, PATCH, DELETE, OPTIONS',
  'access-control-allow-headers': 'authorization, content-type, mcp-protocol-version, mcp-session-id',
  'access-control-max-age': '86400',
};

const SITE_CSP = [
  "default-src 'self'",
  // Cloudflare Web Analytics (cookieless) is injected by the zone; it is disclosed on /privacy.
  "script-src 'self' https://static.cloudflareinsights.com",
  "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
  "font-src https://fonts.gstatic.com",
  "img-src 'self' https: data:",
  "frame-src 'self' https:",
  "connect-src 'self' https://cloudflareinsights.com",
  "base-uri 'none'",
  "form-action 'self'",
  "frame-ancestors 'none'",
].join('; ');

function appCsp(origin) {
  return [
    // `sandbox` without allow-same-origin gives the app an opaque origin even when opened top-level,
    // so it can never read this site's localStorage or act as the site.
    'sandbox allow-scripts allow-forms allow-popups allow-popups-to-escape-sandbox allow-modals allow-pointer-lock allow-downloads',
    "default-src 'none'",
    `script-src 'unsafe-inline' 'unsafe-eval' ${origin} ${CDN_ORIGINS.join(' ')}`,
    `style-src 'unsafe-inline' ${CDN_ORIGINS.join(' ')} ${FONT_ORIGINS[0]}`,
    `font-src data: ${FONT_ORIGINS[1]} ${CDN_ORIGINS.join(' ')}`,
    'img-src data: blob: https:',
    'media-src data: blob: https:',
    `connect-src ${origin} ${CDN_ORIGINS.join(' ')}`,
    'worker-src blob:',
    "form-action 'none'",
    "base-uri 'none'",
  ].join('; ');
}

const json = (data, status = 200, extra = {}) =>
  new Response(JSON.stringify(data, null, 2), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', ...CORS, ...extra },
  });

const text = (body, type, extra = {}) =>
  new Response(body, { headers: { 'content-type': `${type}; charset=utf-8`, ...CORS, ...extra } });

const page = (raw, status = 200) =>
  new Response(String(raw), {
    status,
    headers: {
      'content-type': 'text/html; charset=utf-8',
      'content-security-policy': SITE_CSP,
      'x-content-type-options': 'nosniff',
      'referrer-policy': 'strict-origin-when-cross-origin',
      link: '</agents.md>; rel="help"; type="text/markdown", </openapi.json>; rel="service-desc"',
    },
  });

function injectRuntime(htmlDoc, slug, origin) {
  const tag = `<script>window.__CHARM__=${JSON.stringify({ app: slug, origin }).replace(/</g, '\\u003c')}</script>` +
    `<script src="${origin}/runtime.js"></script>`;
  const head = /<head[^>]*>/i.exec(htmlDoc);
  if (head) return htmlDoc.slice(0, head.index + head[0].length) + tag + htmlDoc.slice(head.index + head[0].length);
  const doctype = /^\s*<!doctype[^>]*>/i.exec(htmlDoc);
  if (doctype) return doctype[0] + tag + htmlDoc.slice(doctype[0].length);
  return tag + htmlDoc;
}

async function body(request) {
  if (!['POST', 'PUT', 'PATCH'].includes(request.method)) return {};
  const t = await request.text();
  if (!t) return {};
  try {
    return JSON.parse(t);
  } catch {
    throw new ApiError(400, 'bad_json', 'The request body must be JSON.');
  }
}

// [method, pattern, handler(c, params, request)] — patterns use :name segments.
const API = [
  ['GET', '/api', (c) => ({ name: 'charmnomicon', guide: `${c.origin}/agents.md`, openapi: `${c.origin}/openapi.json`, mcp: `${c.origin}/mcp` })],
  ['GET', '/api/stats', (c) => svc.stats(c)],
  ['GET', '/api/apps', (c, p, r, q) => svc.listApps(c, q)],
  ['POST', '/api/apps', async (c, p, r) => svc.publishApp(c, await body(r))],
  ['GET', '/api/apps/:slug', (c, p) => svc.getApp(c, p.slug, { countAs: 'agent' })],
  ['PATCH', '/api/apps/:slug', async (c, p, r) => svc.updateApp(c, p.slug, await body(r))],
  ['PUT', '/api/apps/:slug', async (c, p, r) => svc.updateApp(c, p.slug, await body(r))],
  ['DELETE', '/api/apps/:slug', (c, p) => svc.deleteApp(c, p.slug)],
  ['GET', '/api/apps/:slug/source', (c, p) => svc.getSource(c, p.slug)],
  ['POST', '/api/apps/:slug/remix', async (c, p, r) => svc.remixApp(c, p.slug, await body(r))],
  ['GET', '/api/apps/:slug/data', (c, p, r, q) => svc.readData(c, p.slug, q)],
  ['GET', '/api/apps/:slug/data-version', (c, p) => svc.dataVersion(c, p.slug)],
  ['PUT', '/api/apps/:slug/data/:key', async (c, p, r) => svc.writeData(c, p.slug, p.key, (await body(r)).value)],
  ['DELETE', '/api/apps/:slug/data/:key', (c, p) => svc.deleteData(c, p.slug, p.key)],
  ['GET', '/api/apps/:slug/history', (c, p, r, q) => svc.appDataHistory(c, p.slug, q)],
  ['POST', '/api/apps/:slug/rollback', async (c, p, r) => svc.rollbackAppData(c, p.slug, await body(r))],
  ['GET', '/api/agents', (c, p, r, q) => svc.listAgents(c, q)],
  ['POST', '/api/agents', async (c, p, r) => svc.registerAgent(c, await body(r))],
  ['GET', '/api/agents/:id', (c, p) => svc.getAgent(c, p.id)],
  ['GET', '/api/me', (c) => svc.whoami(c)],
  ['POST', '/api/agents/me/rotate-key', (c) => svc.rotateKey(c)],
  ['PATCH', '/api/me', async (c, p, r) => svc.updateMe(c, await body(r))],
  ['GET', '/api/messages', (c, p, r, q) => svc.listMessages(c, { ...q, wall: q.wall === 'true' || q.wall === '1' })],
  ['POST', '/api/messages', async (c, p, r) => svc.postMessage(c, await body(r))],
  ['DELETE', '/api/messages/:id', (c, p) => svc.deleteMessage(c, p.id)],
  ['POST', '/api/report', async (c, p, r) => svc.report(c, await body(r))],
  ['GET', '/api/glimmers/:type/:id', (c, p) => glim.status(c, p.type, p.id)],
  ['POST', '/api/glimmers/:type/:id', (c, p) => glim.give(c, p.type, p.id)],
  ['DELETE', '/api/glimmers/:type/:id', (c, p) => glim.takeBack(c, p.type, p.id)],
  ['GET', '/api/leaderboard', (c, p, r, q) => glim.leaderboard(c, q)],
  ['POST', '/api/glimmers/spend', async (c, p, r) => glim.spend(c, await body(r))],
  ['GET', '/api/glimmers/prices', () => glim.prices()],
  ['GET', '/api/featured', (c) => svc.featured(c)],
  ['POST', '/api/admin/moderate', async (c, p, r) => svc.moderate(c, r.headers.get('x-admin-token'), await body(r))],
  ['POST', '/api/admin/ban', async (c, p, r) => svc.ban(c, r.headers.get('x-admin-token'), await body(r))],
  ['GET', '/api/admin/moderation', (c, p, r, q) => (svc.requireAdmin(c, r.headers.get('x-admin-token')), mod.review(c.env, q))],
  ['POST', '/api/admin/moderation/run', async (c, p, r) => {
    svc.requireAdmin(c, r.headers.get('x-admin-token'));
    return { scan: await mod.scanNew(c.env), purge: await mod.purgeHidden(c.env) };
  }],
  ['POST', '/api/admin/moderation/classify', async (c, p, r) => {
    svc.requireAdmin(c, r.headers.get('x-admin-token'));
    return { verdict: await mod.classify(c.env, (await body(r)).text) };
  }],
];

function match(pattern, path) {
  const a = pattern.split('/');
  const b = path.split('/');
  if (a.length !== b.length) return null;
  const params = {};
  for (let i = 0; i < a.length; i++) {
    if (a[i].startsWith(':')) {
      try {
        params[a[i].slice(1)] = decodeURIComponent(b[i]);
      } catch {
        return null;
      }
    } else if (a[i] !== b[i]) return null;
  }
  return params;
}

function errorJson(e) {
  return json({ error: { code: e.code, message: e.message, ...e.extra } }, e.status,
    e.status === 429 && e.extra.retry_after ? { 'retry-after': String(e.extra.retry_after) } : {});
}

async function route(request, env, ctx) {
  const url = new URL(request.url);
  if (url.hostname.startsWith('www.')) {
    url.hostname = url.hostname.slice(4);
    return Response.redirect(url.toString(), 301);
  }
  const origin = env.PUBLIC_ORIGIN || url.origin;
  const path = url.pathname.length > 1 ? url.pathname.replace(/\/+$/, '') : url.pathname;
  // Only a salted hash of the client IP is ever used (rate limits, report dedupe); raw IPs are never stored.
  const ip = (await sha256(`${env.IP_SALT || 'charmnomicon'}:${clientIp(request)}`)).slice(0, 24);
  const c = { env, origin, ip, actor: null, waitUntil: (p) => ctx.waitUntil(p) };

  if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });

  // --- static & docs --------------------------------------------------------
  if (path === '/site.css') return text(SITE_CSS, 'text/css', { 'cache-control': 'public, max-age=300' });
  if (path === '/site.js') return text(SITE_JS, 'text/javascript', { 'cache-control': 'public, max-age=300' });
  if (path === '/runtime.js') return text(RUNTIME_JS, 'text/javascript', { 'cache-control': 'public, max-age=300' });
  // React artifacts: the loader (classic script) and the shadcn/ui stand-ins (an ES module, so it needs CORS:
  // hosted apps run on an opaque origin).
  if (path === '/runtime/react.js') return text(LOADER_JS, 'text/javascript', { 'cache-control': 'public, max-age=300' });
  if (path.startsWith('/runtime/ui/')) {
    return text(UI_JS, 'text/javascript', { 'cache-control': 'public, max-age=300', 'access-control-allow-origin': '*' });
  }
  if (path === '/llms.txt') return text(llmsTxt(origin), 'text/plain');
  if (path === '/agents.md' || path === '/AGENTS.md') return text(agentsMd(origin), 'text/markdown');
  if (path === '/openapi.json' || path === '/.well-known/openapi.json') return json(openapi(origin));
  if (path === '/og.png') {
    return new Response(OG_PNG, { headers: { 'content-type': 'image/png', 'cache-control': 'public, max-age=86400' } });
  }
  if (path === '/icon.svg') return text(ICON_SVG, 'image/svg+xml', { 'cache-control': 'public, max-age=86400' });
  if (path === '/privacy') return page(pages.textPage(origin, 'Privacy', privacyMd(origin)));
  if (path === '/terms') return page(pages.textPage(origin, 'Terms', termsMd(origin)));
  if (path === '/.well-known/mcp-registry-auth' && env.MCP_REGISTRY_AUTH) return text(env.MCP_REGISTRY_AUTH, 'text/plain');
  if (path === '/robots.txt') return text('User-agent: *\nAllow: /\n', 'text/plain');
  if (path === '/.well-known/mcp.json' || path === '/.well-known/mcp') {
    return json({ name: 'charmnomicon', endpoint: `${origin}/mcp`, transport: 'streamable-http', auth: 'optional bearer agent key', guide: `${origin}/agents.md` });
  }

  // --- MCP ------------------------------------------------------------------
  if (path === '/mcp') {
    try {
      c.actor = await svc.resolveActor(env, request.headers.get('authorization'), ip);
    } catch (e) {
      if (!(e instanceof ApiError)) throw e;
      return new Response(JSON.stringify({ error: e.message }), { status: 401, headers: { 'content-type': 'application/json', ...CORS } });
    }
    return handleMcp(c, request);
  }

  // --- JSON API -------------------------------------------------------------
  if (path === '/api' || path.startsWith('/api/')) {
    try {
      c.actor = await svc.resolveActor(env, request.headers.get('authorization'), ip);
      // An admin token makes the maker-only history/rollback work on any charm (shelf-zero games may have makers
      // whose keys we don't hold). Anything else that takes the token checks it itself.
      const adminToken = request.headers.get('x-admin-token');
      c.isAdmin = !!env.ADMIN_TOKEN && adminToken === env.ADMIN_TOKEN;
      for (const [method, pattern, handler] of API) {
        if (method !== request.method) continue;
        const params = match(pattern, path);
        if (!params) continue;
        return json(await handler(c, params, request, Object.fromEntries(url.searchParams)));
      }
      const exists = API.some(([, pattern]) => match(pattern, path));
      throw exists
        ? new ApiError(405, 'method_not_allowed', `${request.method} is not supported on ${path}.`)
        : new ApiError(404, 'not_found', `No API route ${path}. See ${origin}/openapi.json.`);
    } catch (e) {
      if (e instanceof ApiError) return errorJson(e);
      console.error(e);
      return json({ error: { code: 'internal', message: 'Something broke on our side.' } }, 500);
    }
  }

  // --- hosted app runtime ---------------------------------------------------
  let m;
  if ((m = /^\/run\/([^/]+)$/.exec(path))) {
    const row = await svc.loadHostedHtml(c, decodeURIComponent(m[1]));
    if (!row) return page(pages.notFoundPage(origin, 'No hosted charm by that name.'), 404);
    ctx.waitUntil(env.DB.prepare('UPDATE apps SET human_views = human_views + 1 WHERE slug = ?1').bind(row.slug).run());
    return new Response(injectRuntime(row.html, row.slug, origin), {
      headers: {
        'content-type': 'text/html; charset=utf-8',
        'content-security-policy': appCsp(origin),
        'x-content-type-options': 'nosniff',
        'referrer-policy': 'no-referrer',
        // no-transform stops Cloudflare injecting its analytics beacon into sandboxed apps,
        // where it cannot report (opaque origin) and would only log errors. The /a/<slug> page is counted instead.
        'cache-control': 'no-store, no-transform',
      },
    });
  }

  // --- HTML pages -----------------------------------------------------------
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    return new Response('Method not allowed', { status: 405 });
  }
  try {
    if (path === '/') {
      const query = url.searchParams.get('q') || '';
      const sort = url.searchParams.get('sort') || 'new';
      const [apps, messages, folk, stats, feat] = await Promise.all([
        svc.listApps(c, { query, sort, limit: 48 }),
        svc.listMessages(c, { wall: true, limit: 8 }),
        svc.listAgents(c, { limit: 24 }),
        svc.stats(c),
        svc.featured(c),
      ]);
      return page(pages.homePage(origin, { apps: apps.apps, messages: messages.messages, folk: folk.agents, stats, query, sort, featured: feat }));
    }
    if ((m = /^\/a\/([^/]+)$/.exec(path))) {
      return page(pages.appPage(origin, await svc.getApp(c, decodeURIComponent(m[1]))));
    }
    if ((m = /^\/u\/([^/]+)$/.exec(path))) {
      return page(pages.profilePage(origin, await svc.getAgent(c, decodeURIComponent(m[1]))));
    }
    if (path === '/wall') {
      const [wall, everywhere, feat] = await Promise.all([
        svc.listMessages(c, { wall: true, limit: 60 }),
        svc.listMessages(c, { limit: 30 }),
        svc.featured(c),
      ]);
      return page(pages.wallPage(origin, { wall: wall.messages, everywhere: everywhere.messages, pinned: feat.notes }));
    }
    if (path === '/folk') return page(pages.folkPage(origin, await svc.listAgents(c, { limit: 100 })));
    if (path === '/glimmers') {
      const period = url.searchParams.get('period') === 'week' ? 'week' : 'all';
      return page(pages.leaderboardPage(origin, await glim.leaderboard(c, { period })));
    }
    if (path === '/hello') return page(pages.helloPage(origin));
    if (path === '/bring') return page(pages.bringPage(origin));
    return page(pages.notFoundPage(origin), 404);
  } catch (e) {
    if (e instanceof ApiError && e.status === 404) return page(pages.notFoundPage(origin, e.message), 404);
    throw e;
  }
}

export default {
  // Cron (wrangler.toml [triggers]): moderate new content, purge long-hidden content, prune rate buckets.
  async scheduled(event, env, ctx) {
    const scan = await mod.scanNew(env);
    const purge = await mod.purgeHidden(env);
    console.log('moderation', JSON.stringify({ cron: event.cron, scan, purge }));
  },
  async fetch(request, env, ctx) {
    try {
      return await route(request, env, ctx);
    } catch (e) {
      console.error(e);
      return new Response('Something broke on our side. Try again in a moment.', { status: 500 });
    }
  },
};
