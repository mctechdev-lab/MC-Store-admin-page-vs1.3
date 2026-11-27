// ============================================================
//  api/admin-auth.js — login, logout, "who am I", and server-side audit
//  Same-origin only (no CORS headers). All checks happen on the server.
// ============================================================
const A = require('../lib/admin-session.js');

module.exports = async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'POST') return res.status(405).json({ ok: false, error: 'POST only' });
  if (!A.sameOrigin(req)) return res.status(403).json({ ok: false, error: 'Bad origin' });
  const body = req.body && typeof req.body === 'object' ? req.body : {};
  const action = body.action || 'login';

  try {
    if (action === 'me') {
      const s = A.readSession(req);
      return s ? res.status(200).json({ ok: true, email: s.email, role: s.role })
               : res.status(401).json({ ok: false, code: 'unauthenticated' });
    }

    if (action === 'logout') {
      res.setHeader('Set-Cookie', A.clearCookie());
      return res.status(200).json({ ok: true });
    }

    if (action === 'audit') {                       // replaces the old browser-side logging
      const s = A.requireAdmin(req, res, 'audit.write'); if (!s) return;
      const event = String(body.event || '');
      if (!/^[a-z0-9_]{2,60}$/.test(event)) return res.status(400).json({ ok: false, error: 'Bad event' });
      await A.audit(s, req, event, body.detail);
      return res.status(200).json({ ok: true });
    }

    if (action === 'login') {
      const email = String(body.email || '').trim().toLowerCase().slice(0, 254);
      const password = String(body.password || '').slice(0, 200);
      const key = `${A.clientIp(req)}|${email}`;
      if (A.throttled(key)) return res.status(429).json({ ok: false, error: 'Too many attempts. Try again in 15 minutes.' });

      const acct = A.findAccount(email);
      const good = A.verifyPassword(password, acct ? acct.hash : A.DUMMY_HASH) && !!acct;   // same work either way
      if (!good) {
        A.recordFail(key);
        await new Promise(r => setTimeout(r, 600));
        await A.audit(null, req, 'admin_login_failed', email);
        return res.status(401).json({ ok: false, error: 'Wrong email or password.' });
      }
      A.clearFails(key);
      res.setHeader('Set-Cookie', A.sessionCookie(A.createSession(acct)));
      await A.audit({ email: acct.email.toLowerCase() }, req, 'admin_login', acct.role);
      return res.status(200).json({ ok: true, email: acct.email.toLowerCase(), role: acct.role });
    }

    return res.status(400).json({ ok: false, error: 'Unknown action' });
  } catch (e) {
    console.error('admin-auth error:', e.message);
    return res.status(500).json({ ok: false, error: 'Admin sign-in is not configured on the server.' });
  }
};
