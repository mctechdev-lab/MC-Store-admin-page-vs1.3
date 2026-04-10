// ============================================================
//  api/get-sender-code.js
//  Fetches your validated addresses from Shipbubble
//  Correct endpoint: GET /v1/shipping/address
// ============================================================

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

  // action=validate: validate a new address
  if (req.method === 'POST') {
    const { action, payload } = req.body || {};

    if (action === 'validate') {
      // POST /shipping/address/validate
      const r    = await fetch(`${BASE}/shipping/address/validate`, {
        method:  'POST',
        headers: hdrs,
        body:    JSON.stringify({
          name:    payload.name    || 'MC Store',
          email:   payload.email   || 'mcstore.care@gmail.com',
          phone:   payload.phone   || '+2348056230366',
          address: payload.address || 'Opposite Bovas Filling Station, Bodija'
        })
      });
      const text = await r.text();
      let data; try { data = JSON.parse(text); } catch { data = { raw: text }; }
      return res.status(200).json({ status: r.status, ok: r.ok, data });
    }
  }

  // Default: GET all validated addresses
  const r    = await fetch(`${BASE}/shipping/address`, { headers: hdrs });
  const text = await r.text();
  let data; try { data = JSON.parse(text); } catch { data = { raw: text }; }

  return res.status(200).json({ status: r.status, ok: r.ok, data });
        }
