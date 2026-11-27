const test = require('node:test'); const assert = require('node:assert/strict');
process.env.ADMIN_SESSION_SECRET = 'x'.repeat(40);
const A = require('../lib/admin-session.js');
const owner = { email: 'Owner@mcstore.com.ng', role: 'owner', hash: A.hashPassword('correct horse battery') };
const staff = { email: 'staff@mcstore.com.ng', role: 'support', hash: A.hashPassword('another long password') };
process.env.ADMIN_ACCOUNTS = JSON.stringify([owner, staff]);
const reqWith = (cookie, extra = {}) => ({ method: 'POST', headers: { host: 'admin.test', origin: 'https://admin.test', cookie, ...extra }, socket: {} });
const fakeRes = () => { const r = { code: 200, headers: {}, body: null, setHeader(k, v) { r.headers[k] = v; }, status(c) { r.code = c; return r; }, json(b) { r.body = b; return r; } }; return r; };
const cookieOf = (tok) => `${A.COOKIE}=${encodeURIComponent(tok)}`;

test('password: right passes, wrong fails, hash is salted', () => {
  assert.ok(A.verifyPassword('correct horse battery', owner.hash));
  assert.ok(!A.verifyPassword('correct horse batterz', owner.hash));
  assert.notEqual(A.hashPassword('same'), A.hashPassword('same'));
  assert.ok(!A.verifyPassword('x', 'garbage'));
});
test('session: valid cookie is accepted and email is case-insensitive', () => {
  const s = A.readSession(reqWith(cookieOf(A.createSession(owner))));
  assert.deepEqual(s, { email: 'owner@mcstore.com.ng', role: 'owner' });
});
test('session: tampered payload or signature is rejected', () => {
  const tok = A.createSession(staff); const [b, m] = tok.split('.');
  const forged = Buffer.from(JSON.stringify({ v: 1, sub: 'staff@mcstore.com.ng', role: 'owner', exp: 9999999999 })).toString('base64url');
  assert.equal(A.readSession(reqWith(cookieOf(`${forged}.${m}`))), null);
  assert.equal(A.readSession(reqWith(cookieOf(`${b}.${m.slice(0, -2)}AA`))), null);
  assert.equal(A.readSession(reqWith(cookieOf('nonsense'))), null);
  assert.equal(A.readSession(reqWith('')), null);
});
test('session: expires after 8 hours', () => {
  const tok = A.createSession(owner, Date.now());
  assert.ok(A.readSession(reqWith(cookieOf(tok)), Date.now() + 7 * 3600e3));
  assert.equal(A.readSession(reqWith(cookieOf(tok)), Date.now() + 8.1 * 3600e3), null);
});
test('session: signed with a different secret is rejected', () => {
  const tok = A.createSession(owner); process.env.ADMIN_SESSION_SECRET = 'y'.repeat(40);
  assert.equal(A.readSession(reqWith(cookieOf(tok))), null);
  process.env.ADMIN_SESSION_SECRET = 'x'.repeat(40);
});
test('session: removing the account or changing its role takes effect immediately', () => {
  const tok = A.createSession(staff);
  process.env.ADMIN_ACCOUNTS = JSON.stringify([owner]);
  assert.equal(A.readSession(reqWith(cookieOf(tok))), null);
  process.env.ADMIN_ACCOUNTS = JSON.stringify([owner, { ...staff, role: 'manager' }]);
  assert.equal(A.readSession(reqWith(cookieOf(tok))).role, 'manager');
  process.env.ADMIN_ACCOUNTS = JSON.stringify([owner, staff]);
});
test('secret shorter than 32 characters refuses to work', () => {
  const keep = process.env.ADMIN_SESSION_SECRET; process.env.ADMIN_SESSION_SECRET = 'short';
  assert.throws(() => A.createSession(owner)); process.env.ADMIN_SESSION_SECRET = keep;
});
test('roles: owner can do all, support is limited', () => {
  assert.ok(A.can('owner', 'anything.at.all'));
  assert.ok(A.can('support', 'orders.read'));
  assert.ok(!A.can('support', 'products.write'));
  assert.ok(!A.can('support', 'promo.manage'));
  assert.ok(!A.can('nobody', 'orders.read'));
});
test('requireAdmin: no cookie -> 401; wrong role -> 403; ok -> session', () => {
  let r = fakeRes(); assert.equal(A.requireAdmin(reqWith(''), r, 'orders.read'), null); assert.equal(r.code, 401);
  const c = cookieOf(A.createSession(staff));
  r = fakeRes(); assert.equal(A.requireAdmin(reqWith(c), r, 'products.write'), null); assert.equal(r.code, 403);
  r = fakeRes(); assert.equal(A.requireAdmin(reqWith(c), r, 'orders.read').role, 'support'); assert.equal(r.headers['Cache-Control'], 'no-store');
});
test('origin: cross-site or missing Origin on POST is refused, GET allowed', () => {
  const c = cookieOf(A.createSession(owner));
  let r = fakeRes(); assert.equal(A.requireAdmin(reqWith(c, { origin: 'https://evil.example' }), r, null), null); assert.equal(r.code, 403);
  r = fakeRes(); assert.equal(A.requireAdmin(reqWith(c, { origin: undefined }), r, null), null); assert.equal(r.code, 403);
  r = fakeRes(); assert.ok(A.requireAdmin({ ...reqWith(c, { origin: undefined }), method: 'GET' }, r, null));
});
test('cookie flags: HttpOnly, Secure, SameSite=Strict, __Host- prefix', () => {
  const c = A.sessionCookie('t'); assert.match(c, /^__Host-mc_admin=/); for (const f of ['HttpOnly', 'Secure', 'SameSite=Strict', 'Path=/']) assert.ok(c.includes(f));
  assert.ok(!c.includes('Domain'));
});
test('throttle: locks after 5 failures, clears on success, expires after 15 min', () => {
  const k = 'ip|a'; const t0 = 1e12; for (let i = 0; i < 5; i++) { assert.ok(!A.throttled(k, t0)); A.recordFail(k, t0); }
  assert.ok(A.throttled(k, t0 + 1000)); assert.ok(!A.throttled(k, t0 + 16 * 60e3));
  A.recordFail(k, t0 + 16 * 60e3); A.clearFails(k); assert.ok(!A.throttled(k, t0 + 16 * 60e3));
});

// ---- login endpoint end-to-end (real handler, stand-in req/res) ----
test('login endpoint: good login sets the cookie; bad ones are generic and do not reveal which part is wrong', async () => {
  const h = require('../api/admin-auth.js');
  const call = async (body, extra) => { const r = fakeRes(); await h({ ...reqWith('', extra), body }, r); return r; };
  let r = await call({ email: 'owner@mcstore.com.ng', password: 'correct horse battery' });
  assert.equal(r.code, 200); assert.match(r.headers['Set-Cookie'], /HttpOnly/); assert.equal(r.body.role, 'owner');
  const wrongPw = await call({ email: 'owner@mcstore.com.ng', password: 'nope nope nope!' });
  const wrongUser = await call({ email: 'ghost@mcstore.com.ng', password: 'correct horse battery' });
  assert.equal(wrongPw.code, 401); assert.equal(wrongUser.code, 401); assert.equal(wrongPw.body.error, wrongUser.body.error);
  assert.equal(wrongPw.headers['Set-Cookie'], undefined);
  r = await call({ email: 'owner@mcstore.com.ng', password: 'correct horse battery' }, { origin: 'https://evil.example' });
  assert.equal(r.code, 403);
  const me = fakeRes(); await h({ ...reqWith(cookieOf(A.createSession(owner))), body: { action: 'me' } }, me);
  assert.equal(me.code, 200); assert.equal(me.body.email, 'owner@mcstore.com.ng');
  const out = fakeRes(); await h({ ...reqWith(''), body: { action: 'logout' } }, out); assert.match(out.headers['Set-Cookie'], /Max-Age=0/);
});
