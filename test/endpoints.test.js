const test = require('node:test'); const assert = require('node:assert/strict');
process.env.ADMIN_SESSION_SECRET = 'x'.repeat(40);
const A = require('../lib/admin-session.js');
process.env.ADMIN_ACCOUNTS = JSON.stringify([
  { email: 'o@x.ng', role: 'owner', hash: A.hashPassword('pw-pw-pw-pw-1') },
  { email: 's@x.ng', role: 'support', hash: A.hashPassword('pw-pw-pw-pw-2') }]);
// Needs `npm install` first (userinfo.js imports firebase-admin). No real network calls are made: fetch is replaced.
let netCalls = 0; global.fetch = async () => { netCalls++; return { ok: true, status: 200, json: async () => ({}), text: async () => '{}' }; };
const res = () => { const r = { code: 200, headers: {}, body: null, setHeader(k, v) { r.headers[k] = v; }, status(c) { r.code = c; return r; }, json(b) { r.body = b; return r; }, end() { return r; } }; return r; };
const as = (acct) => `${A.COOKIE}=${encodeURIComponent(A.createSession(acct))}`;
const owner = { email: 'o@x.ng', role: 'owner' }, support = { email: 's@x.ng', role: 'support' };
const rq = (method, cookie, body) => ({ method, headers: { host: 'a.test', origin: 'https://a.test', cookie: cookie || '' }, body, socket: {} });
const load = async (f) => { const m = await import('../api/' + f); return m.default || m; };
const cases = [
  ['add-product.js', 'POST', { action: 'saveProduct', product: {} }],
  ['get-sender-code.js', 'GET', undefined],
  ['shipping.js', 'POST', { action: 'getRates', payload: {} }],
  ['userinfo.js', 'GET', undefined],
  ['contacts-sync.js', 'GET', undefined],
  ['sync-brevo-contact.js', 'POST', { email: 'a@b.c' }],
];
for (const [file, method, body] of cases) {
  test(`${file}: anonymous caller is refused (401) and nothing leaves the server`, async () => {
    const h = await load(file); const before = netCalls; const r = res();
    await h(rq(method, '', body), r);
    assert.equal(r.code, 401); assert.equal(netCalls, before);
    assert.equal(r.headers['Access-Control-Allow-Origin'], undefined, 'no wildcard CORS');
  });
  test(`${file}: cross-site request is refused (403) even with a valid cookie`, async () => {
    const h = await load(file); const r = res(); const q = rq(method, as(owner), body);
    if (method !== 'POST') return;   // GET requests change nothing
    q.headers.origin = 'https://evil.example';
    await h(q, r); assert.equal(r.code, 403);
  });
}
test('support role cannot use product or shipping endpoints', async () => {
  for (const [file, method, body] of [['add-product.js', 'POST', { action: 'saveProduct', product: {} }], ['get-sender-code.js', 'GET'], ['shipping.js', 'POST', { action: 'debug' }]]) {
    const h = await load(file); const r = res(); await h(rq(method, as(support), body), r);
    assert.equal(r.code, 403, file);
  }
});
test('only the owner can push contacts to Brevo', async () => {
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'k'; process.env.BREVO_API_KEY = 'b';
  const sync = await load('contacts-sync.js'); let r = res();
  await sync(rq('POST', as(support), { action: 'syncAll' }), r); assert.equal(r.code, 403);
  const brevo = await load('sync-brevo-contact.js'); r = res();
  await brevo(rq('POST', as(support), { email: 'a@b.c' }), r); assert.equal(r.code, 403);
});
test('owner is allowed through to the real handler logic', async () => {
  const h = await load('add-product.js'); const r = res();
  await h(rq('POST', as(owner), { action: 'nope' }), r); assert.equal(r.code, 400);   // got past auth, then "Unknown action"
});
