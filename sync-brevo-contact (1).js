// ============================================================
//  api/sync-brevo-contact.js
//  Pushes one contact to Brevo. Runs server-side only — the Brevo
//  API key must NEVER appear in browser code, since it grants full
//  send/contacts access to the account.
// ============================================================

const BREVO_KEY = process.env.BREVO_API_KEY || '';

// Brevo requires phone numbers in international format (+234...). Checkout
// data is usually stored as a local Nigerian number (0801...), so convert
// it — and if it can't be confidently formatted, just leave it out rather
// than letting one bad phone number block the whole contact from saving.
function formatNigerianPhone(raw) {
  if (!raw) return null;
  const digits = String(raw).replace(/[^\d+]/g, '');
  if (digits.startsWith('+234') && digits.length === 14) return digits;
  if (digits.startsWith('234') && digits.length === 13) return '+' + digits;
  if (digits.startsWith('0') && digits.length === 11) return '+234' + digits.slice(1);
  return null; // unrecognised format — omit rather than fail the sync
}

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ ok: false, error: 'Method not allowed' });

  if (!BREVO_KEY) {
    return res.status(500).json({ ok: false, error: 'BREVO_API_KEY not set in Vercel env vars' });
  }

  try {
    const { email, first_name, last_name, phone, source } = req.body || {};
    if (!email) return res.status(400).json({ ok: false, error: 'Missing email' });

    const attributes = {};
    if (first_name) attributes.FIRSTNAME = first_name;
    if (last_name)  attributes.LASTNAME  = last_name;
    const formattedPhone = formatNigerianPhone(phone);
    if (formattedPhone) attributes.SMS = formattedPhone; // Brevo's default phone field

    const brevoRes = await fetch('https://api.brevo.com/v3/contacts', {
      method: 'POST',
      headers: {
        'api-key': BREVO_KEY,
        'Content-Type': 'application/json',
        'Accept': 'application/json'
      },
      body: JSON.stringify({
        email,
        attributes,
        updateEnabled: true // if the contact already exists, update instead of erroring
      })
    });

    // Brevo returns 204 (no body) on success, or 201 with the new contact id
    if (brevoRes.status === 204 || brevoRes.status === 201) {
      return res.status(200).json({ ok: true });
    }

    const errText = await brevoRes.text();
    return res.status(200).json({ ok: false, error: errText });

  } catch (err) {
    return res.status(500).json({ ok: false, error: err.message });
  }
};
