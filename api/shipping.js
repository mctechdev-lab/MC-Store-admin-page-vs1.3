// ============================================================
//  api/shipping.js — MC Store Shipbubble Integration
//  Based on official Shipbubble API docs:
//  - POST /shipping/address/validate  → get address_code
//  - GET  /shipping/category          → get real category IDs
//  - POST /shipping/fetch_rates       → get courier rates
// ============================================================

const KEY  = process.env.SHIPBUBBLE_API_KEY ||
  'sb_prod_4e080eb614d512ca670304775edc1cee9c75df92bf3c06fe82fee00714b44b3a';
const BASE = 'https://api.shipbubble.com/v1';

// ── HTTP helper ──
async function sb(path, body, method) {
  method = method || (body ? 'POST' : 'GET');
  try {
    const r = await fetch(`${BASE}${path}`, {
      method,
      headers: {
        Authorization:  `Bearer ${KEY}`,
        'Content-Type': 'application/json',
        Accept:         'application/json'
      },
      body: method !== 'GET' ? JSON.stringify(body) : undefined
    });
    const text = await r.text();
    let data;
    try { data = JSON.parse(text); } catch { data = { raw: text }; }
    return { ok: r.ok, status: r.status, data };
  } catch (e) {
    return { ok: false, status: 0, data: { message: e.message } };
  }
}

// ── Phone normaliser → +234XXXXXXXXXX ──
function toPhone(p) {
  if (!p) return '+2348056230366';
  const d = String(p).replace(/\D/g, '');
  if (d.startsWith('234') && d.length >= 13) return '+' + d;
  if (d.startsWith('0')   && d.length === 11) return '+234' + d.slice(1);
  if (d.length === 10)                         return '+234' + d;
  return '+' + d;
}

// ── Today yyyy-mm-dd ──
function today() { return new Date().toISOString().slice(0, 10); }

// ── Validate address → returns address_code (integer) ──
async function validateAddress(name, email, phone, fullAddress) {
  const r = await sb('/shipping/address/validate', {
    name:    name    || 'Customer',
    email:   email   || 'customer@mcstore.ng',
    phone:   toPhone(phone),
    address: fullAddress   // full address as one string
  });
  const code = r.data?.data?.address_code ?? null;
  return { ok: r.ok && code !== null, code: code ? Number(code) : null, raw: r };
}

// ── Get real category ID from Shipbubble ──
async function getCategoryId() {
  const r = await sb('/shipping/category');
  const list = r.data?.data?.categories || r.data?.categories || [];
  const arr  = Array.isArray(list) ? list : Object.values(list);
  // Pick first available category
  if (arr.length) return arr[0].id || arr[0].category_id || arr[0];
  return null; // will cause proper error instead of "Invalid category"
}

// ── Build package items for Shipbubble ──
function buildItems(cartItems) {
  return (cartItems || []).map(i => ({
    name:        String(i.name || 'Item').slice(0, 60),
    description: String(i.name || 'Item').slice(0, 60),
    unit_weight: String(Number(i.weight || 0.3)),
    unit_amount: String(Math.round(Number(i.price || 1000))), // naira — Shipbubble accepts naira
    quantity:    String(Number(i.quantity || 1))
  }));
}

// ════════════════════════════════════════
//  MAIN HANDLER
// ════════════════════════════════════════
export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin',  '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST')   return res.status(405).json({ ok: false });

  const { action, payload = {} } = req.body || {};

  // ══════════════════════════════════════
  //  GET RATES — customer checkout
  // ══════════════════════════════════════
  if (action === 'getRates') {
    const { recipientAddress, items = [] } = payload;

    const senderCode = process.env.SHIPBUBBLE_SENDER_CODE
      ? Number(process.env.SHIPBUBBLE_SENDER_CODE) : null;

    if (!senderCode) {
      return res.status(200).json({
        ok: false,
        error: 'Delivery is not set up yet. Please contact the store.',
        setup_needed: true
      });
    }

    // Step 1 — get real category ID
    const categoryId = await getCategoryId();
    if (!categoryId) {
      return res.status(200).json({
        ok: false,
        error: 'Could not get package categories from Shipbubble. Please try again.'
      });
    }

    // Step 2 — validate recipient address
    const fullAddr = [
      recipientAddress.street,
      recipientAddress.city,
      recipientAddress.state,
      'Nigeria'
    ].filter(Boolean).join(', ');

    const recip = await validateAddress(
      recipientAddress.fullName || 'Customer',
      recipientAddress.email    || 'customer@mcstore.ng',
      recipientAddress.phone,
      fullAddr
    );

    if (!recip.ok || !recip.code) {
      const errMsg = recip.raw?.data?.message
        || recip.raw?.data?.data?.message
        || 'Could not validate delivery address';
      return res.status(200).json({
        ok: false,
        error: `Address error: ${errMsg}. Please check your street, city and state.`
      });
    }

    // Step 3 — fetch rates
    const rateBody = {
      sender_address_code:   senderCode,
      reciever_address_code: recip.code,   // Shipbubble's own typo
      pickup_date:           today(),
      category_id:           categoryId,
      package_items:         buildItems(items),
      package_dimension:     { length: 20, width: 15, height: 10 }
    };

    const rateRes  = await sb('/shipping/fetch_rates', rateBody);
    const couriers = rateRes.data?.data?.couriers || [];
    const token    = rateRes.data?.data?.request_token || '';

    if (!rateRes.ok || !couriers.length) {
      const msg = rateRes.data?.message
        || rateRes.data?.data?.message
        || 'No couriers available for this route';
      return res.status(200).json({ ok: false, error: `Shipbubble: ${msg}` });
    }

    const rates = couriers.map(c => ({
      courier_id:             String(c.courier_id || ''),
      courier_name:           c.courier_name  || 'Courier',
      service_code:           c.service_code  || '',
      delivery_fee:           Number(c.total  || c.rate_card_amount || 0),
      eta:                    c.delivery_eta  || '2–5 days',
      logo:                   c.courier_image || '',
      request_token:          token,
      recipient_address_code: recip.code,
      is_cod:                 c.is_cod_available || false
    }));

    return res.status(200).json({ ok: true, rates, request_token: token });
  }

  // ══════════════════════════════════════
  //  VALIDATE SENDER (admin setup)
  // ══════════════════════════════════════
  if (action === 'registerSender') {
    const { name, email, phone, address, city, state } = payload;
    if (!address || !city || !state) {
      return res.status(200).json({ ok: false, error: 'Address, city and state are required' });
    }
    const fullAddr = `${address}, ${city}, ${state}, Nigeria`;
    const r = await validateAddress(name, email, phone, fullAddr);
    if (!r.ok) {
      return res.status(200).json({
        ok: false,
        error: r.raw?.data?.message || r.raw?.data?.data?.message || 'Address validation failed'
      });
    }
    return res.status(200).json({
      ok: true,
      address_code: r.code,
      message: `Validated! Set SHIPBUBBLE_SENDER_CODE = ${r.code} in Vercel env vars.`
    });
  }

  // ══════════════════════════════════════
  //  BOOK SHIPMENT (admin confirms order)
  // ══════════════════════════════════════
  if (action === 'bookShipment') {
    const { order } = payload;
    if (!order) return res.status(400).json({ ok: false, error: 'No order provided' });

    const senderCode = process.env.SHIPBUBBLE_SENDER_CODE
      ? Number(process.env.SHIPBUBBLE_SENDER_CODE) : null;
    if (!senderCode) return res.status(200).json({ ok: false, error: 'SHIPBUBBLE_SENDER_CODE not set' });

    const items = (() => {
      try { return typeof order.items === 'string' ? JSON.parse(order.items) : (order.items || []); }
      catch { return []; }
    })();

    // Get or validate recipient code
    let recipCode = order.shipbubble_recipient_code
      ? Number(order.shipbubble_recipient_code) : null;

    if (!recipCode) {
      const fullAddr = [order.delivery_street, order.delivery_city, order.delivery_state, 'Nigeria']
        .filter(Boolean).join(', ');
      const reg = await validateAddress(
        order.customer_name, order.customer_email, order.customer_phone, fullAddr
      );
      if (!reg.ok) return res.status(200).json({ ok: false, error: 'Could not validate recipient address' });
      recipCode = reg.code;
    }

    // Get request token if not saved
    let requestToken = order.shipbubble_request_token || '';
    if (!requestToken) {
      const categoryId = await getCategoryId();
      const rr = await sb('/shipping/fetch_rates', {
        sender_address_code:   senderCode,
        reciever_address_code: recipCode,
        pickup_date:           today(),
        category_id:           categoryId,
        package_items:         buildItems(items),
        package_dimension:     { length: 20, width: 15, height: 10 }
      });
      requestToken = rr.data?.data?.request_token || '';
      if (!requestToken) return res.status(200).json({ ok: false, error: 'Could not get booking token from Shipbubble' });
    }

    const { ok, data } = await sb('/shipping/labels', {
      request_token: requestToken,
      service_code:  order.shipbubble_service_code || '',
      ...(order.payment_method === 'cash_on_delivery'
        ? { is_cod: true, cod_amount: Number(order.total || 0) } : {})
    });

    if (!ok) {
      return res.status(200).json({
        ok: false,
        error: data?.message || data?.data?.message || 'Shipbubble could not create shipment'
      });
    }

    const s = data?.data || {};
    return res.status(200).json({
      ok:           true,
      tracking_id:  s.tracking_id  || s.id || '',
      courier_name: s.courier_name || s.courier || '',
      label_url:    s.label_url    || s.waybill_url || ''
    });
  }

  // ══════════════════════════════════════
  //  DEBUG
  // ══════════════════════════════════════
  if (action === 'debug') {
    const senderCode = process.env.SHIPBUBBLE_SENDER_CODE || 'NOT SET';
    const [wallet, cats, addrs] = await Promise.all([
      sb('/shipping/wallet/balance'),
      sb('/shipping/category'),
      sb('/shipping/address')
    ]);
    // Test validate an address
    const testValidate = await validateAddress(
      'Test Customer', 'test@mcstore.ng', '+2348012345678',
      '14 Admiralty Way, Lekki Phase 1, Lagos, Nigeria'
    );
    return res.status(200).json({
      api_key_prefix:    KEY.slice(0, 20) + '...',
      sender_code_env:   senderCode,
      wallet:            wallet.data,
      categories:        cats.data,
      my_addresses:      addrs.data,
      test_validate:     { ok: testValidate.ok, code: testValidate.code, raw: testValidate.raw?.data }
    });
  }

  return res.status(400).json({ ok: false, error: `Unknown action: ${action}` });
}
