// api/get-sender-code.js — fetch existing Shipbubble addresses
export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const KEY  = process.env.SHIPBUBBLE_API_KEY ||
    'sb_prod_4e080eb614d512ca670304775edc1cee9c75df92bf3c06fe82fee00714b44b3a';
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
    wallet,
    key_prefix: KEY.slice(0, 18) + '...'
  });
        }
