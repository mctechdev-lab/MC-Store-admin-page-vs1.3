// api/contacts-sync.js
// Syncs MC Store customers to Brevo via their Contacts API.
//
// IMPORTANT: pulls customers from the `orders` table, not a `customers`
// table — nothing in MC Store ever writes to a `customers` table in
// Supabase, so that table is always empty. Every real customer (new or
// years-old) has placed at least one order, so `orders` is the reliable
// source of truth for "who are our actual customers."

const SB_URL  = 'https://kswikkoqfpyxuurzxail.supabase.co';
const SB_KEY  = process.env.SUPABASE_SERVICE_ROLE_KEY || '';
const BREVO_KEY = process.env.BREVO_API_KEY || '';

// ── Get every customer who has ever placed an order, deduped by email ──
async function getAllOrderCustomers() {
  const res = await fetch(
    `${SB_URL}/rest/v1/orders?select=customer_name,customer_email,customer_phone,created_at&order=created_at.asc`,
    { headers: { apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}` } }
  );
  if (!res.ok) throw new Error(await res.text());
  const orders = await res.json();

  const seen = new Map(); // email -> latest known contact info
  for (const o of orders) {
    if (!o.customer_email) continue;
    seen.set(o.customer_email.toLowerCase(), {
      email: o.customer_email,
      name: o.customer_name || '',
      phone: o.customer_phone || ''
    });
  }
  return Array.from(seen.values());
}

async function pushToBrevo(contact) {
  const nameParts = (contact.name || '').trim().split(/\s+/);
  const attributes = {};
  if (nameParts[0]) attributes.FIRSTNAME = nameParts[0];
  if (nameParts.slice(1).join(' ')) attributes.LASTNAME = nameParts.slice(1).join(' ');
  if (contact.phone) attributes.SMS = contact.phone;

  const res = await fetch('https://api.brevo.com/v3/contacts', {
    method: 'POST',
    headers: { 'api-key': BREVO_KEY, 'Content-Type': 'application/json', 'Accept': 'application/json' },
    body: JSON.stringify({ email: contact.email, attributes, updateEnabled: true })
  });
  if (res.status === 204 || res.status === 201) return { ok: true };
  const errText = await res.text().catch(() => `HTTP ${res.status}`);
  return { ok: false, error: errText };
}

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  if (!SB_KEY) {
    return res.status(500).json({ ok: false, error: 'SUPABASE_SERVICE_ROLE_KEY not set in Vercel env vars' });
  }
  if (!BREVO_KEY) {
    return res.status(500).json({ ok: false, error: 'BREVO_API_KEY not set in Vercel env vars' });
  }

  try {
    const { action } = req.method === 'POST' ? (req.body || {}) : req.query;

    // ── GET: just return the customer list, for inspection ──
    if (req.method === 'GET') {
      const contacts = await getAllOrderCustomers();
      return res.status(200).json({ ok: true, count: contacts.length, contacts });
    }

    // ── POST syncAll: push every distinct order customer to Brevo ──
    if (action === 'syncAll') {
      const contacts = await getAllOrderCustomers();
      let synced = 0, failed = 0, lastError = '';
      for (const c of contacts) {
        try {
          const result = await pushToBrevo(c);
          if (result.ok) synced++; else { failed++; lastError = result.error; }
        } catch (e) { failed++; lastError = e.message; }
        await new Promise(r => setTimeout(r, 150)); // gentle rate limit
      }
      return res.status(200).json({ ok: true, synced, failed, total: contacts.length, lastError });
    }

    return res.status(400).json({ ok: false, error: 'Unknown action' });
  } catch (err) {
    return res.status(500).json({ ok: false, error: err.message });
  }
};
