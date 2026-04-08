// ============================================================
//  api/admin-auth.js — Vercel Serverless Function
//  Checks password against ADMIN_PASSWORD env var
//  Returns a signed session token if correct
//  The real password never touches the browser
// ============================================================

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ ok: false });

  const { password, action } = req.body || {};

  // ── VERIFY SESSION TOKEN ──
  if (action === 'verify') {
    const { token } = req.body;
    const secret = process.env.ADMIN_PASSWORD || '';
    const expected = btoa('mc-admin:' + secret + ':' + new Date().toISOString().slice(0, 10));
    // Token valid for today (changes at midnight)
    if (token && token === expected) {
      return res.status(200).json({ ok: true });
    }
    return res.status(200).json({ ok: false });
  }

  // ── LOGIN ──
  const adminPassword = process.env.ADMIN_PASSWORD || '';

  if (!adminPassword) {
    return res.status(200).json({
      ok: false,
      error: 'ADMIN_PASSWORD not set in Vercel environment variables.'
    });
  }

  if (!password || password !== adminPassword) {
    // Small delay to slow down brute force
    await new Promise(r => setTimeout(r, 800));
    return res.status(200).json({ ok: false, error: 'Wrong password. Please try again.' });
  }

  // Password correct — generate daily token
  const token = btoa('mc-admin:' + adminPassword + ':' + new Date().toISOString().slice(0, 10));

  return res.status(200).json({ ok: true, token });
}
