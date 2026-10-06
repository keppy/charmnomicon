// Shared helpers: errors, ids, hashing, rate limits, validation.

export class ApiError extends Error {
  constructor(status, code, message, extra = {}) {
    super(message);
    this.status = status;
    this.code = code;
    this.extra = extra;
  }
}

export const now = () => Math.floor(Date.now() / 1000);

const ALPHA = 'abcdefghijkmnpqrstuvwxyz23456789';
export function rand(n = 4) {
  const bytes = crypto.getRandomValues(new Uint8Array(n));
  let s = '';
  for (const b of bytes) s += ALPHA[b % ALPHA.length];
  return s;
}

export function b64url(bytes) {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export async function sha256(text) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

export function slugify(text, max = 32) {
  const s = String(text || '')
    .normalize('NFKD')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, max)
    .replace(/-+$/g, '');
  return s || 'charm';
}

export function esc(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// --- input validation -------------------------------------------------------

export function str(input, field, { max = 200, min = 0, required = false, def = '' } = {}) {
  const v = input?.[field];
  if (v === undefined || v === null || v === '') {
    if (required) throw new ApiError(400, 'missing_field', `\`${field}\` is required.`);
    return def;
  }
  if (typeof v !== 'string') throw new ApiError(400, 'bad_field', `\`${field}\` must be a string.`);
  const t = v.trim();
  if (t.length < min) throw new ApiError(400, 'bad_field', `\`${field}\` must be at least ${min} characters.`);
  if (t.length > max) throw new ApiError(400, 'too_long', `\`${field}\` must be at most ${max} characters.`);
  return t;
}

export function emoji(input, field, def) {
  const v = str(input, field, { max: 16, def });
  // Keep it to a short glyph cluster; we do not try to validate "is emoji".
  return [...v].slice(0, 4).join('') || def;
}

export function httpsUrl(input, field, { required = false } = {}) {
  const v = str(input, field, { max: 500, required });
  if (!v) return '';
  let u;
  try {
    u = new URL(v);
  } catch {
    throw new ApiError(400, 'bad_url', `\`${field}\` must be a valid URL.`);
  }
  if (u.protocol !== 'https:') throw new ApiError(400, 'bad_url', `\`${field}\` must be an https:// URL.`);
  return u.toString();
}

export function tags(input) {
  let v = input?.tags;
  if (v === undefined || v === null || v === '') return '';
  if (typeof v === 'string') v = v.split(',');
  if (!Array.isArray(v)) throw new ApiError(400, 'bad_field', '`tags` must be an array of strings.');
  const out = [...new Set(v.map((t) => slugify(String(t), 24)).filter((t) => t && t !== 'charm'))].slice(0, 8);
  return out.join(',');
}

// --- rate limits (fixed window counters in D1) ------------------------------

export async function limit(env, bucket, max, windowSec) {
  const t = now();
  const row = await env.DB.prepare(
    `INSERT INTO rate (k, n, reset) VALUES (?1, 1, ?2)
     ON CONFLICT(k) DO UPDATE SET
       n = CASE WHEN rate.reset <= ?3 THEN 1 ELSE rate.n + 1 END,
       reset = CASE WHEN rate.reset <= ?3 THEN ?2 ELSE rate.reset END
     RETURNING n, reset`
  )
    .bind(bucket, t + windowSec, t)
    .first();
  if (row.n > max * (env.RELAX_LIMITS === '1' ? 100 : 1)) {
    throw new ApiError(429, 'rate_limited', `Slow down a little: try again in ${row.reset - t}s.`, {
      retry_after: row.reset - t,
    });
  }
  if (Math.random() < 0.01) {
    await env.DB.prepare('DELETE FROM rate WHERE reset <= ?1').bind(t).run();
  }
}

export function clientIp(request) {
  return request.headers.get('cf-connecting-ip') || request.headers.get('x-forwarded-for') || 'local';
}

export function assertWritable(env) {
  if (env.READ_ONLY === '1') {
    throw new ApiError(503, 'read_only', 'Charmnomicon is in read-only mode for a moment. Browsing still works.');
  }
}
