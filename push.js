// ============================================================
//  api/push.js — Vercel Serverless Function
//  Sends Web Push notifications to subscribed users
//  Called by: user-management.html (admin sends notif)
//             Triggered server-side for order updates
// ============================================================

const SB_URL  = process.env.SUPABASE_URL  || "https://kswikkoqfpyxuurzxail.supabase.co";
const SB_KEY  = process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_ANON_KEY || "";
const VAPID_PUBLIC  = process.env.VAPID_PUBLIC_KEY  || "";
const VAPID_PRIVATE = process.env.VAPID_PRIVATE_KEY || "";
const VAPID_EMAIL   = "mailto:mcstore.care@gmail.com";

// ── Web Push crypto helpers (no npm package needed) ──
const crypto  = require('crypto');
const https   = require('https');
const url_mod = require('url');

// Decode base64url
function b64u(str) {
  const b64 = str.replace(/-/g,'+').replace(/_/g,'/');
  return Buffer.from(b64, 'base64');
}

// Base64url encode
function toB64u(buf) {
  return Buffer.from(buf).toString('base64').replace(/\+/g,'-').replace(/\//g,'_').replace(/=/g,'');
}

// Build VAPID JWT Authorization header
function buildVapidAuth(audience) {
  const header = toB64u(JSON.stringify({ typ:'JWT', alg:'ES256' }));
  const exp    = Math.floor(Date.now()/1000) + 12*3600;
  const payload= toB64u(JSON.stringify({ aud: audience, exp, sub: VAPID_EMAIL }));
  const sigInput = `${header}.${payload}`;

  // Decode private key PEM from base64url
  const privPem = Buffer.from(VAPID_PRIVATE, 'base64').toString('utf8');
  const sign    = crypto.createSign('SHA256');
  sign.update(sigInput);
  const derSig  = sign.sign({ key: privPem, dsaEncoding:'ieee-p1363' });
  const sig     = toB64u(derSig);

  return `vapid t=${sigInput}.${sig},k=${VAPID_PUBLIC}`;
}

// Send one push message
async function sendPush(subscription, payload) {
  const endpoint = subscription.endpoint;
  const parsed   = url_mod.parse(endpoint);
  const audience = `${parsed.protocol}//${parsed.host}`;
  const vapidAuth = buildVapidAuth(audience);

  const body = Buffer.from(JSON.stringify(payload));

  return new Promise((resolve) => {
    const options = {
      hostname: parsed.hostname,
      path:     parsed.path,
      method:   'POST',
      headers: {
        'TTL':            '86400',
        'Content-Type':   'application/json',
        'Content-Length': body.length,
        'Authorization':  vapidAuth,
      }
    };

    // Add encryption keys if present (keys.p256dh + keys.auth)
    if (subscription.keys) {
      options.headers['Crypto-Key']  = `dh=${subscription.keys.p256dh}`;
      options.headers['Encryption']  = `salt=${toB64u(crypto.randomBytes(16))}`;
    }

    const req = https.request(options, res => {
      resolve({ ok: res.statusCode < 300, status: res.statusCode, endpoint });
    });
    req.on('error', e => resolve({ ok: false, error: e.message, endpoint }));
    req.write(body);
    req.end();
  });
}

// Fetch subscriptions from Supabase
async function getSubscriptions(uids) {
  const filter = uids && uids.length
    ? `uid=in.(${uids.map(u=>`"${u}"`).join(',')})&`
    : '';
  const res = await fetch(
    `${SB_URL}/rest/v1/push_subscriptions?${filter}select=uid,subscription&limit=1000`,
    { headers: { apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}` } }
  );
  return res.ok ? res.json() : [];
}

// Save notification to DB
async function saveNotification(uids, title, message, type) {
  const rows = uids.map(uid => ({ uid, title, message, type: type||'admin', is_read: false }));
  await fetch(`${SB_URL}/rest/v1/notifications`, {
    method: 'POST',
    headers: {
      apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}`,
      'Content-Type': 'application/json', Prefer: 'return=minimal'
    },
    body: JSON.stringify(rows)
  });
}

// ── MAIN HANDLER ──
module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin',  '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST')    return res.status(405).json({ error: 'POST only' });

  try {
    const { action, uid, uids, title, message, type, url, subscription } = req.body;

    // ── ACTION: subscribe — save a push subscription ──
    if (action === 'subscribe') {
      if (!uid || !subscription) return res.status(400).json({ error: 'uid and subscription required' });
      await fetch(`${SB_URL}/rest/v1/push_subscriptions`, {
        method: 'POST',
        headers: {
          apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}`,
          'Content-Type': 'application/json',
          Prefer: 'resolution=merge-duplicates,return=minimal'
        },
        body: JSON.stringify({ uid, subscription: JSON.stringify(subscription), updated_at: new Date().toISOString() })
      });
      return res.status(200).json({ ok: true });
    }

    // ── ACTION: send — send push to one or many users ──
    if (action === 'send') {
      if (!title || !message) return res.status(400).json({ error: 'title and message required' });

      const targetUids = uids || (uid ? [uid] : null); // null = send to ALL
      const subs = await getSubscriptions(targetUids);

      if (!subs.length) {
        // No push subs yet, just save to DB
        if (targetUids) await saveNotification(targetUids, title, message, type);
        return res.status(200).json({ ok: true, sent: 0, saved: targetUids?.length || 0 });
      }

      const payload = { title, body: message, icon: '/favicon-192.png', url: url || '/app-skeleton.html' };

      // Send to all subscriptions
      const results = await Promise.allSettled(
        subs.map(row => {
          const sub = typeof row.subscription === 'string'
            ? JSON.parse(row.subscription) : row.subscription;
          return sendPush(sub, payload);
        })
      );

      const sent   = results.filter(r => r.status==='fulfilled' && r.value?.ok).length;
      const failed = results.length - sent;

      // Save to notifications table for in-app display
      const notifUids = targetUids || subs.map(s=>s.uid).filter((v,i,a)=>a.indexOf(v)===i);
      if (notifUids.length) await saveNotification(notifUids, title, message, type);

      return res.status(200).json({ ok: true, sent, failed, total: subs.length });
    }

    return res.status(400).json({ error: 'Unknown action' });

  } catch(e) {
    console.error('[push]', e);
    return res.status(500).json({ ok: false, error: e.message });
  }
};
