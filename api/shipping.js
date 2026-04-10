// ============================================================
//  api/shipping.js — MC Store Shipbubble Integration
//
//  CORRECT Shipbubble API (from official docs):
//  - GET  /shipping/address              → list addresses
//  - POST /shipping/address/validate     → create/validate address
//  - POST /shipping/fetch_rates          → get rates
//    Required: sender_address_code (int), reciever_address_code (int),
//              pickup_date, category_id, package_items, package_dimension
//  - POST /shipping/labels               → book shipment
// ============================================================

const KEY  = process.env.SHIPBUBBLE_API_KEY ||
  'sb_prod_4e080eb614d512ca670304775edc1cee9c75df92bf3c06fe82fee00714b44b3a';
const BASE = 'https://api.shipbubble.com/v1';

// ── HTTP helper ──
async function sb(path, body, method = 'POST') {
  const url = `${BASE}${path}`;
  console.log(`[SB] ${method} ${path}`, body ? JSON.stringify(body).slice(0, 400) : '');
  try {
    const r = await fetch(url, {
      method,
      headers: {
        Authorization:  `Bearer ${KEY}`,
        'Content-Type': 'application/json',
        Accept:         'application/json'
      },
      body: method !== 'GET' ? JSON.stringify(body) : undefined
    });
    const raw = await r.text();
    let data; try { data = JSON.parse(raw); } catch { data = { raw }; }
    console.log(`[SB] ${path} → ${r.status}`, JSON.stringify(data).slice(0, 500));
    return { ok: r.ok, status: r.status, data };
  } catch (e) {
    console.error(`[SB] ${path} error:`, e.message);
    return { ok: false, status: 0, data: { message: e.message } };
  }
}

// ── Phone → +234XXXXXXXXXX ──
function toPhone(p) {
  if (!p) return '+2348056230366';
  const d = String(p).replace(/\D/g, '');
  if (d.startsWith('234') && d.length >= 13) return '+' + d;
  if (d.startsWith('0') && d.length === 11)  return '+234' + d.slice(1);
  if (d.length === 10)                        return '+234' + d;
  return '+' + d;
}

// ── Validate address → get address_code ──
async function validateAddress(details) {
  const r = await sb('/shipping/address/validate', {
    name:    details.name    || 'Customer',
    email:   details.email   || 'customer@mcstore.ng',
    phone:   toPhone(details.phone),
    address: [details.address, details.city, details.state, 'Nigeria']
              .filter(Boolean).join(', ')
  });
  const code = r.data?.data?.address_code || null;
  console.log('[SB] validateAddress code:', code);
  return { ok: r.ok && !!code, code: code ? Number(code) : null, raw: r };
}

// ── Today's date in yyyy-mm-dd ──
function today() {
  return new Date().toISOString().slice(0, 10);
}

// ── Build package_items array ──
function buildItems(items) {
  return (items || []).map(i => ({
    name:        String(i.name || 'Item'),
    description: String(i.name || 'Item'),
    unit_weight: String(Number(i.weight) || 0.3),
    unit_amount: String(Math.round((Number(i.price) || 1000) * 100)), // kobo
    quantity:    String(Number(i.quantity) || 1)
  }));
}

// ── MAIN HANDLER ──
export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin',  '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST')   return res.status(405).json({ ok: false, error: 'Method not allowed' });

  const { action, payload = {} } = req.body || {};

  // ══════════════════════════════════════════
  //  GET RATES
  // ══════════════════════════════════════════
  if (action === 'getRates') {
    const { recipientAddress, items = [], totalWeight = 0.5 } = payload;

    // Sender code from env var
    const senderCode = process.env.SHIPBUBBLE_SENDER_CODE
      ? Number(process.env.SHIPBUBBLE_SENDER_CODE)
      : null;

    if (!senderCode) {
      return res.status(200).json({
        ok:    false,
        error: 'Delivery not configured yet. The store admin needs to set SHIPBUBBLE_SENDER_CODE in Vercel env vars.',
        setup_needed: true
      });
    }

    // Validate recipient address → get address_code
    const recip = await validateAddress({
      name:    recipientAddress.fullName || 'Customer',
      email:   recipientAddress.email    || 'customer@mcstore.ng',
      phone:   recipientAddress.phone,
      address: recipientAddress.street   || '',
      city:    recipientAddress.city     || '',
      state:   recipientAddress.state    || ''
    });

    if (!recip.ok || !recip.code) {
      const msg = recip.raw?.data?.message || recip.raw?.data?.errors?.[0] || 'Could not validate delivery address';
      return res.status(200).json({
        ok:    false,
        error: `Address error: ${msg}. Please check your street, city and state are correct.`
      });
    }

    // Fetch rates
    const rateBody = {
      sender_address_code:   senderCode,
      reciever_address_code: recip.code,   // note: Shipbubble typo "reciever"
      pickup_date:           today(),
      category_id:           1,            // general items
      package_items:         buildItems(items),
      package_dimension:     { length: 20, width: 15, height: 10 }
    };

    const rateRes = await sb('/shipping/fetch_rates', rateBody);
    const couriers     = rateRes.data?.data?.couriers || [];
    const requestToken = rateRes.data?.data?.request_token || '';

    if (!rateRes.ok || !couriers.length) {
      const msg = rateRes.data?.message || rateRes.data?.data?.message || 'No couriers available';
      console.error('[shipping] getRates failed:', rateRes.status, msg);
      return res.status(200).json({ ok: false, error: `Shipbubble: ${msg}` });
    }

    const rates = couriers.map(r => ({
      courier_id:             r.courier_id   || '',
      courier_name:           r.courier_name || 'Courier',
      service_code:           r.service_code || '',
      delivery_fee:           Number(r.total || r.rate_card_amount || 0),
      eta:                    r.delivery_eta || '2–5 days',
      logo:                   r.courier_image || '',
      request_token:          requestToken,
      recipient_address_code: recip.code,
      is_cod:                 r.is_cod_available || false
    }));

    return res.status(200).json({ ok: true, rates, request_token: requestToken });
  }

  // ══════════════════════════════════════════
  //  REGISTER / VALIDATE SENDER (admin)
  // ══════════════════════════════════════════
  if (action === 'registerSender') {
    const { name, email, phone: p, address, city, state } = payload;
    if (!address || !city || !state) {
      return res.status(200).json({ ok: false, error: 'Address, city and state are required' });
    }
    const r = await validateAddress({ name, email, phone: p, address, city, state });
    if (!r.ok) {
      const msg = r.raw?.data?.message || r.raw?.data?.errors?.[0] || 'Could not validate address';
      return res.status(200).json({ ok: false, error: msg, raw: r.raw?.data });
    }
    return res.status(200).json({
      ok:           true,
      address_code: r.code,
      message:      `Address validated! Add this to Vercel env vars: SHIPBUBBLE_SENDER_CODE = ${r.code}`
    });
  }

  // ══════════════════════════════════════════
  //  BOOK SHIPMENT (admin)
  // ══════════════════════════════════════════
  if (action === 'bookShipment') {
    const { order } = payload;
    if (!order) return res.status(400).json({ ok: false, error: 'No order provided' });

    const senderCode = process.env.SHIPBUBBLE_SENDER_CODE
      ? Number(process.env.SHIPBUBBLE_SENDER_CODE)
      : null;
    if (!senderCode) return res.status(200).json({ ok: false, error: 'SHIPBUBBLE_SENDER_CODE not set' });

    const items = (() => {
      try { return typeof order.items === 'string' ? JSON.parse(order.items) : (order.items || []); }
      catch { return []; }
    })();

    // Validate recipient
    const recipCode = order.shipbubble_recipient_code
      ? Number(order.shipbubble_recipient_code)
      : null;

    let finalRecipCode = recipCode;
    if (!finalRecipCode) {
      const reg = await validateAddress({
        name:    order.customer_name,
        email:   order.customer_email,
        phone:   order.customer_phone,
        address: order.delivery_street,
        city:    order.delivery_city,
        state:   order.delivery_state
      });
      if (!reg.ok) return res.status(200).json({ ok: false, error: 'Could not validate recipient address' });
      finalRecipCode = reg.code;
    }

    // Get request token if not saved
    let requestToken = order.shipbubble_request_token || '';
    if (!requestToken) {
      const rr = await sb('/shipping/fetch_rates', {
        sender_address_code:   senderCode,
        reciever_address_code: finalRecipCode,
        pickup_date:           today(),
        category_id:           1,
        package_items:         buildItems(items),
        package_dimension:     { length: 20, width: 15, height: 10 }
      });
      requestToken = rr.data?.data?.request_token || '';
      if (!requestToken) return res.status(200).json({ ok: false, error: 'Could not get booking token' });
    }

    const isCOD = order.payment_method === 'cash_on_delivery';
    const { ok, data } = await sb('/shipping/labels', {
      request_token:         requestToken,
      service_code:          order.shipbubble_service_code || '',
      ...(isCOD ? { is_cod: true, cod_amount: Number(order.total || 0) } : {})
    });

    if (!ok || !data?.data) {
      return res.status(200).json({ ok: false, error: data?.message || 'Shipbubble could not create shipment' });
    }

    const s = data.data;
    return res.status(200).json({
      ok:           true,
      tracking_id:  s.tracking_id  || s.id || '',
      courier_name: s.courier_name || s.courier || '',
      label_url:    s.label_url    || s.waybill_url || ''
    });
  }

  // ══════════════════════════════════════════
  //  DEBUG
  // ══════════════════════════════════════════
  if (action === 'debug') {
    const senderCode = process.env.SHIPBUBBLE_SENDER_CODE || 'NOT SET';

    // Test wallet balance (simplest authenticated call)
    const wallet = await sb('/shipping/wallet/balance', {}, 'GET');

    // Get existing addresses
    const addrs = await sb('/shipping/address', {}, 'GET');

    // Test validate a new address
    const validate = await sb('/shipping/address/validate', {
      name:    'Test Customer',
      email:   'test@mcstore.ng',
      phone:   '+2348012345678',
      address: '14 Admiralty Way, Lekki Phase 1, Lagos, Nigeria'
    });

    return res.status(200).json({
      api_key_prefix:  KEY.slice(0, 20) + '...',
      sender_code_env: senderCode,
      wallet_balance:  { status: wallet.status, data: wallet.data },
      my_addresses:    { status: addrs.status,  data: addrs.data  },
      validate_test:   { status: validate.status, data: validate.data }
    });
  }

  return res.status(400).json({ ok: false, error: `Unknown action: ${action}` });
}
