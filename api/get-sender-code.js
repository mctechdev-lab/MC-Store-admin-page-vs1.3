// ============================================================
//  api/get-sender-code.js
//  Fetches your existing registered sender addresses from
//  Shipbubble and returns them so you can pick the right one
// ============================================================

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const SHIPBUBBLE_KEY = process.env.SHIPBUBBLE_API_KEY ||
    'sb_prod_4e080eb614d512ca670304775edc1cee9c75df92bf3c06fe82fee00714b44b3a';
  const BASE = 'https://api.shipbubble.com/v1';

  const hdrs = {
    Authorization:  `Bearer ${SHIPBUBBLE_KEY}`,
    'Content-Type': 'application/json',
    Accept:         'application/json'
  };

  const results = {};

  // Try every possible GET endpoint to find your addresses
  const endpoints = [
    '/shipping/sender-address',
    '/shipping/sender-addresses',
    '/shipping/addresses',
    '/address',
    '/addresses',
    '/user/addresses',
    '/shipping/pickup-addresses'
  ];

  for (const ep of endpoints) {
    try {
      const r    = await fetch(`${BASE}${ep}`, { headers: hdrs });
      const text = await r.text();
      let data;
      try { data = JSON.parse(text); } catch { data = { raw: text }; }
      results[ep] = { status: r.status, data };
      if (r.ok) break; // found it
    } catch(e) {
      results[ep] = { error: e.message };
    }
  }

  return res.status(200).json({ results });
}
