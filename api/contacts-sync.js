// api/contacts-sync.js
// Syncs MC Store customers to SendBaba automatically
// Called when: new customer registers, or manually from admin panel

const SB_URL       = 'https://kswikkoqfpyxuurzxail.supabase.co';
const SB_KEY       = process.env.SUPABASE_SERVICE_KEY || 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Imtzd2lra29xZnB5eHV1cnp4YWlsIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc3MTM2MTMwNCwiZXhwIjoyMDg2OTM3MzA0fQ.Z5UvrKaNwUB2fPbcGRnSkw773X7oL9kE3u5PbUay9mI';
const SENDBABA_KEY = process.env.SENDBABA_API_KEY || '';
const SENDBABA_URL = 'https://api.sendbaba.com/api/v1';

// ── Get customers from Supabase ──
async function getCustomers(limit=500) {
  const res = await fetch(
    `${SB_URL}/rest/v1/customers?select=uid,full_name,email,phone,created_at&order=created_at.desc&limit=${limit}`,
    { headers: { apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}` } }
  );
  return res.ok ? res.json() : [];
}

// ── Add contact to SendBaba ──
async function addToSendBaba(contact) {
  if (!SENDBABA_KEY) return { ok: false, reason: 'No API key' };
  const res = await fetch(`${SENDBABA_URL}/contacts`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${SENDBABA_KEY}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      email:      contact.email,
      first_name: (contact.full_name||'').split(' ')[0] || 'Customer',
      last_name:  (contact.full_name||'').split(' ').slice(1).join(' ') || '',
      phone:      contact.phone || '',
      tags:       ['mc-store-customer'],
      custom_fields: {
        customer_id:  contact.uid,
        joined_date:  contact.created_at?.slice(0,10) || ''
      }
    })
  });
  return { ok: res.ok };
}

// ── Bulk sync all customers ──
async function bulkSync() {
  const customers = await getCustomers(500);
  if (!customers.length) return { ok: true, synced: 0 };

  let synced = 0;
  for (const c of customers) {
    if (!c.email) continue;
    const r = await addToSendBaba(c);
    if (r.ok) synced++;
    await new Promise(resolve => setTimeout(resolve, 100)); // rate limit
  }
  return { ok: true, synced, total: customers.length };
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const { action } = req.method === 'POST' ? (req.body||{}) : req.query;

  // ── GET: Return contacts as JSON (for SendBaba API pull) ──
  if (req.method === 'GET') {
    const customers = await getCustomers(500);
    return res.status(200).json({
      contacts: customers.map(c => ({
        email:      c.email,
        first_name: (c.full_name||'').split(' ')[0] || 'Customer',
        last_name:  (c.full_name||'').split(' ').slice(1).join(' ') || '',
        phone:      c.phone || '',
        tags:       ['mc-store-customer']
      }))
    });
  }

  // ── POST: Push single new customer to SendBaba ──
  if (action === 'syncOne') {
    const { customer } = req.body;
    if (!customer?.email) return res.status(400).json({ ok: false, error: 'No customer data' });
    const result = await addToSendBaba(customer);
    return res.status(200).json(result);
  }

  // ── POST: Bulk sync all customers ──
  if (action === 'syncAll') {
    const result = await bulkSync();
    return res.status(200).json(result);
  }

  return res.status(400).json({ ok: false, error: 'Unknown action' });
}
