// api/get-sender-code.js — fetch existing Shipbubble addresses
import A from '../lib/admin-session.js';
export default async function handler(req, res) {
  const admin = A.requireAdmin(req, res, 'shipping.use'); if (!admin) return;

  const KEY  = process.env.SHIPBUBBLE_API_KEY || '';   // set in Vercel env vars, never in code
  if (!KEY) return res.status(500).json({ ok: false, error: 'SHIPBUBBLE_API_KEY not set in Vercel env vars' });
  const BASE = 'https://api.shipbubble.com/v1';
  const hdrs = {
    Authorization:  `Bearer ${KEY}`,
    'Content-Type': 'application/json',
    Accept:         'application/json'
  };

  async function hit(path, body, method) {
    try {
      const r = await fetch(`${BASE}${path}`, {
        method: method || (body ? 'POST' : 'GET'),
        headers: hdrs,
        body: body ? JSON.stringify(body) : undefined
      });
      const text = await r.text();
      let data; try { data = JSON.parse(text); } catch { data = { raw: text }; }
      return { status: r.status, ok: r.ok, data };
    } catch(e) { return { status: 0, ok: false, data: { message: e.message } }; }
  }

  // action=validate — validate a new address
  if (req.method === 'POST') {
    const { action, payload } = req.body || {};
    if (action === 'validate') {
      const r = await hit('/shipping/address/validate', {
        name:    payload.name    || 'MC Store',
        email:   payload.email   || 'mcstore.care@gmail.com',
        phone:   payload.phone   || '+2348056230366',
        address: payload.address || ''
      });
      return res.status(200).json(r);
    }
  }

  // GET — fetch all existing addresses + wallet balance
  const [addresses, wallet] = await Promise.all([
    hit('/shipping/address'),
    hit('/shipping/wallet/balance')
  ]);

  return res.status(200).json({
    addresses,
    wallet
  });
        }
