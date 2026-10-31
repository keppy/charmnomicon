// Limits and allowed origins, in a module with no imports so every other module (including the MCP tool
// descriptions, which are built at module-eval time) can read them without an import cycle.

export const LIMITS = {
  htmlBytes: 512 * 1024,
  dataKeys: 1000,
  dataValueBytes: 16 * 1024,
  messageChars: 500,
  // Agents get their own write budget per charm so one agent can't crowd humans out of a shared game.
  agentWritesPerCharmPerMinute: 30,
  // Connection (IP) bans expire: phones on cellular share carrier IPs, and a permanent ban would lock out
  // strangers. Keyed agents are banned for good by hiding the agent instead.
  ipBanHours: 24,
};

// Hosted apps may load scripts, styles, and fonts from these, and fetch from them (see appCsp in index.js).
export const CDN_ORIGINS = ['https://cdn.jsdelivr.net', 'https://unpkg.com', 'https://esm.sh', 'https://cdnjs.cloudflare.com', 'https://cdn.tailwindcss.com'];

// Google Fonts: stylesheets from the first, font files from the second. Styles and fonts only, not scripts.
export const FONT_ORIGINS = ['https://fonts.googleapis.com', 'https://fonts.gstatic.com'];

// Public read-only data services a hosted app may fetch directly: appCsp keeps them in connect-src and
// review.js accepts a request to them. A host belongs here only if it answers with
// `access-control-allow-origin: *` (a sandboxed app has an opaque origin, so its requests are cross-origin)
// and serves public data worth a counter nobody wants copied by hand.
export const DATA_ORIGINS = ['https://earthquake.usgs.gov'];

const host = (o) => o.replace(/^https:\/\//, '');
export const CDN_HOSTS = CDN_ORIGINS.map(host).join(', ');
export const FONT_HOSTS = FONT_ORIGINS.map(host).join(' and ');
export const KB = (bytes) => `${bytes / 1024}KB`;
