// ============================================================
//  lib/admin-session.js — server-side admin authentication
//
//  * Passwords are verified on the server with scrypt (never in the browser).
//  * A session is an HMAC-signed token in an HttpOnly, Secure, SameSite=Strict
//    cookie. JavaScript on the page can never read it, so a script injected
//    into an admin page cannot steal it.
//  * Sessions expire (8 hours) and are re-checked against the account list on
//    every request, so removing an account or changing its role takes effect
//    immediately.
//  * Roles map to permissions; every protected API calls requireAdmin().
//
//  Environment variables (Vercel, never in code):
//    ADMIN_SESSION_SECRET  random string, 32+ characters
//    ADMIN_ACCOUNTS        JSON: [{"email":"..","role":"owner","hash":"scrypt$.."}]
//    SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY   (server-side audit log)
// ============================================================
const crypto = require('crypto');

const COOKIE = '__Host-mc_admin';
const SESSION_SECONDS = 8 * 60 * 60;
const SCRYPT = { N: 16384, r: 8, p: 1, keylen: 32 };

const ROLE_PERMISSIONS = {
  owner:   ['*'],
  manager: ['products.read', 'products.write', 'orders.read', 'orders.write', 'shipping.use',
            'users.read', 'vendors.read', 'vendors.write', 'banners.write', 'notifications.send',
            'promo.manage', 'audit.write'],
  support: ['orders.read', 'orders.write', 'users.read', 'audit.write'],
};

const b64u = (buf) => Buffer.from(buf).toString('base64url');
const sha = (s) => crypto.createHash('sha256').update(String(s)).digest();
function safeEqual(a, b) {                       // constant-time string compare
  return crypto.timingSafeEqual(sha(a), sha(b)) && String(a).length === String(b).length;
}

// ── passwords ──
function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const h = crypto.scryptSync(String(password), salt, SCRYPT.keylen, { N: SCRYPT.N, r: SCRYPT.r, p: SCRYPT.p });
  return ['scrypt', SCRYPT.N, SCRYPT.r, SCRYPT.p, b64u(salt), b64u(h)].join('$');
}
function verifyPassword(password, stored) {
  try {
    const [kind, N, r, p, salt, hash] = String(stored).split('$');
    if (kind !== 'scrypt') return false;
    const expected = Buffer.from(hash, 'base64url');
    const got = crypto.scryptSync(String(password), Buffer.from(salt, 'base64url'), expected.length,
      { N: +N, r: +r, p: +p });
    return got.length === expected.length && crypto.timingSafeEqual(got, expected);
  } catch { return false; }
}
// a fixed hash used so a wrong email takes as long as a wrong password
const DUMMY_HASH = hashPassword(crypto.randomBytes(8).toString('hex'));

function accounts() {
  try {
    const list = JSON.parse(process.env.ADMIN_ACCOUNTS || '[]');
    return Array.isArray(list) ? list.filter(a => a && a.email && a.hash && ROLE_PERMISSIONS[a.role]) : [];
  } catch { return []; }
}
function findAccount(email) {
  const e = String(email || '').trim().toLowerCase();
  return accounts().find(a => String(a.email).trim().toLowerCase() === e) || null;
}
function secret() {
  const s = process.env.ADMIN_SESSION_SECRET || '';
  if (s.length < 32) throw new Error('ADMIN_SESSION_SECRET must be at least 32 characters');
  return s;
}

// ── sessions ──
const sign = (body) => b64u(crypto.createHmac('sha256', secret()).update(body).digest());
function createSession(account, now = Date.now()) {
  const payload = { v: 1, sub: String(account.email).toLowerCase(), role: account.role,
                    iat: Math.floor(now / 1000), exp: Math.floor(now / 1000) + SESSION_SECONDS,
                    jti: crypto.randomBytes(8).toString('hex') };
  const body = b64u(JSON.stringify(payload));
  return `${body}.${sign(body)}`;
}
function parseCookies(req) {
  const out = {};
  String(req.headers && req.headers.cookie || '').split(';').forEach(part => {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  });
  return out;
}
// returns { email, role } or null
function readSession(req, now = Date.now()) {
  try {
    const tok = parseCookies(req)[COOKIE];
    if (!tok) return null;
    const [body, mac] = tok.split('.');
    if (!body || !mac || !safeEqual(mac, sign(body))) return null;
    const p = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
    if (p.v !== 1 || !p.exp || p.exp * 1000 < now) return null;
    const acct = findAccount(p.sub);                  // account must still exist
    if (!acct) return null;
    return { email: acct.email.toLowerCase(), role: acct.role };   // role comes from the account list, not the token
  } catch { return null; }
}
const can = (role, perm) => { const l = ROLE_PERMISSIONS[role] || []; return l.includes('*') || l.includes(perm); };

function sessionCookie(token) {
  return `${COOKIE}=${encodeURIComponent(token)}; Path=/; Max-Age=${SESSION_SECONDS}; HttpOnly; Secure; SameSite=Strict`;
}
const clearCookie = () => `${COOKIE}=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Strict`;

// ── request checks ──
function clientIp(req) {
  return String(req.headers['x-forwarded-for'] || '').split(',')[0].trim() || (req.socket && req.socket.remoteAddress) || 'unknown';
}
// state-changing requests must come from this site itself (blocks cross-site forgery)
function sameOrigin(req) {
  if (req.method === 'GET' || req.method === 'HEAD') return true;
  const origin = req.headers.origin;
  if (!origin) return false;
  try { return new URL(origin).host === req.headers.host; } catch { return false; }
}

// login throttle: 5 failures per 15 minutes per (ip,email) on a serverless instance
const fails = new Map();
const WINDOW = 15 * 60 * 1000, MAX_FAILS = 5;
function throttled(key, now = Date.now()) {
  const a = (fails.get(key) || []).filter(t => now - t < WINDOW);
  fails.set(key, a);
  return a.length >= MAX_FAILS;
}
const recordFail = (key, now = Date.now()) => fails.set(key, [...(fails.get(key) || []), now]);
const clearFails = (key) => fails.delete(key);

// ── guard used by every protected endpoint ──
// returns the session, or sends 401/403/400 and returns null
function requireAdmin(req, res, perm) {
  res.setHeader('Cache-Control', 'no-store');
  if (!sameOrigin(req)) { res.status(403).json({ ok: false, error: 'Bad origin' }); return null; }
  const s = readSession(req);
  if (!s) { res.status(401).json({ ok: false, error: 'Please sign in', code: 'unauthenticated' }); return null; }
  if (perm && !can(s.role, perm)) { res.status(403).json({ ok: false, error: 'Not allowed for your role', code: 'forbidden' }); return null; }
  return s;
}

// ── server-side audit log (best effort, never blocks the action) ──
async function audit(session, req, action, detail) {
  try {
    const url = process.env.SUPABASE_URL || 'https://kswikkoqfpyxuurzxail.supabase.co';
    const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
    if (!key) return;
    await fetch(`${url}/rest/v1/admin_audit_log`, {
      method: 'POST',
      headers: { apikey: key, Authorization: `Bearer ${key}`, 'Content-Type': 'application/json', Prefer: 'return=minimal' },
      body: JSON.stringify({ admin_uid: session ? session.email : 'anonymous', admin_email: session ? session.email : 'anonymous',
        action: String(action).slice(0, 80), detail: `${String(detail || '').slice(0, 400)} [ip ${clientIp(req)}]` }),
    });
  } catch { /* logging must never break the request */ }
}

module.exports = { COOKIE, ROLE_PERMISSIONS, hashPassword, verifyPassword, DUMMY_HASH, findAccount, createSession,
  readSession, can, sessionCookie, clearCookie, clientIp, sameOrigin, throttled, recordFail, clearFails, requireAdmin, audit };
