// ============================================================
//  api/shipping.js — Vercel Serverless Function
//
//  CORRECT Shipbubble flow (confirmed from debug):
//  - fetch_rates requires: sender_address_code, recipient_address_code, category
//  - Both addresses must be pre-registered in Shipbubble
//  - Sender code stored in SHIPBUBBLE_SENDER_CODE env var (set via admin panel)
//  - Recipient address registered on-the-fly per order
//  - category: "interstate" for cross-state, "intrastate" for same state
// ============================================================

const SHIPBUBBLE_KEY    = process.env.SHIPBUBBLE_API_KEY    || "sb_prod_4e080eb614d512ca670304775edc1cee9c75df92bf3c06fe82fee00714b44b3a";
const SHIPBUBBLE_BASE   = "https://api.shipbubble.com/v1";
const SENDER_STATE      = "Oyo"; // MC Store is in Oyo state

// Raw HTTP call
async function sb(path, body, method = "POST") {
  const url = `${SHIPBUBBLE_BASE}${path}`;
  console.log(`[SB] ${method} ${path}`, body ? JSON.stringify(body).slice(0, 400) : "");
  try {
    const r = await fetch(url, {
      method,
      headers: {
        Authorization:  `Bearer ${SHIPBUBBLE_KEY}`,
        "Content-Type": "application/json",
        Accept:         "application/json"
      },
      body: method !== "GET" ? JSON.stringify(body) : undefined
    });
    const raw = await r.text();
    let data;
    try { data = JSON.parse(raw); } catch { data = { raw }; }
    console.log(`[SB] ${path} → ${r.status}`, JSON.stringify(data).slice(0, 500));
    return { ok: r.ok, status: r.status, data };
  } catch (e) {
    return { ok: false, status: 0, data: { message: e.message } };
  }
}

// Phone → +234XXXXXXXXXX
function phone(p) {
  if (!p) return "+2348000000000";
  const d = String(p).replace(/\D/g, "");
  if (d.startsWith("234") && d.length >= 13) return "+" + d;
  if (d.startsWith("0")   && d.length === 11) return "+234" + d.slice(1);
  if (d.length === 10)                        return "+234" + d;
  return "+" + d;
}

// State → "Oyo State" format
function stateStr(s) {
  if (!s) return "";
  const t = s.trim();
  if (t.toLowerCase() === "fct" || t.toLowerCase().includes("abuja")) return "FCT";
  if (t.toLowerCase().endsWith(" state")) return t;
  return t + " State";
}

// Determine shipping category
function getCategory(recipientState) {
  const r = (recipientState || "").toLowerCase().replace(" state","").trim();
  const s = SENDER_STATE.toLowerCase();
  return r === s ? "intrastate" : "interstate";
}

// Register an address with Shipbubble → returns address_code
async function registerAddress(details) {
  const body = {
    name:    details.name    || "Customer",
    email:   details.email   || "customer@mcstore.ng",
    phone:   phone(details.phone),
    address: details.address || "",
    city:    details.city    || "",
    state:   stateStr(details.state),
    country: "NG"
  };

  // Try all known Shipbubble address endpoints
  const endpoints = [
    "/shipping/sender-address",
    "/shipping/address",
    "/shipping/addresses",
    "/address/create"
  ];

  for (const endpoint of endpoints) {
    const r = await sb(endpoint, body);
    console.log(`[SB] registerAddress ${endpoint} → ${r.status}`, JSON.stringify(r.data).slice(0, 300));
    if (r.status === 404 || r.status === 405) continue; // try next endpoint
    const d    = r.data?.data || r.data || {};
    const code = d.address_code || d.code || d.id || d.addressCode || null;
    if (r.ok && code) {
      return { ok: true, code: String(code), raw: r };
    }
    // If not 404/405, this is the right endpoint but something else failed
    if (r.status !== 404 && r.status !== 405) {
      return { ok: false, code: null, raw: r };
    }
  }

  return { ok: false, code: null, raw: { data: { message: "No valid Shipbubble address endpoint found" } } };
}

// Build package items
function buildItems(items) {
  return (items || []).map(i => ({
    name:        String(i.name || "Item"),
    description: String(i.name || "Item"),
    unit_weight: String(Number(i.weight)   || 0.3),
    unit_amount: String(Math.round((Number(i.price) || 1000) * 100)),
    quantity:    String(Number(i.quantity) || 1)
  }));
}

// ── MAIN HANDLER ──
export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin",  "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST")   return res.status(405).json({ ok: false, error: "Method not allowed" });

  const { action, payload = {} } = req.body || {};

  // ══════════════════════════════════════════════════
  //  GET RATES
  //  1. Get sender_address_code from env var (set in admin)
  //  2. Register recipient address → get recipient_address_code
  //  3. Call fetch_rates with both codes + category
  // ══════════════════════════════════════════════════
  if (action === "getRates") {
    const { recipientAddress, items = [], totalWeight = 0.5 } = payload;

    // Step 1: Sender code — must be set in Vercel env vars via admin panel
    const senderCode = process.env.SHIPBUBBLE_SENDER_CODE || "";
    if (!senderCode) {
      return res.status(200).json({
        ok:    false,
        error: "Delivery not yet configured. The store admin needs to set up the sender address. Please contact MC Store support.",
        setup_needed: true
      });
    }

    // Step 2: Register recipient address
    const recipReg = await registerAddress({
      name:    recipientAddress.fullName || "Customer",
      email:   recipientAddress.email    || "customer@mcstore.ng",
      phone:   recipientAddress.phone,
      address: recipientAddress.street   || "",
      city:    recipientAddress.city     || "",
      state:   recipientAddress.state    || ""
    });

    if (!recipReg.ok || !recipReg.code) {
      const msg = recipReg.raw?.data?.message || recipReg.raw?.data?.errors?.[0] || "Could not validate your address";
      return res.status(200).json({
        ok:    false,
        error: `Address error: ${msg}. Please check your street, city and state are correct.`
      });
    }

    // Step 3: Fetch rates
    const category = getCategory(recipientAddress.state);
    const weight   = Math.max(0.5, Number(totalWeight) || 0.5);

    const rateRes = await sb("/shipping/fetch_rates", {
      sender_address_code:    senderCode,
      recipient_address_code: recipReg.code,
      package_category:       category,
      package: {
        weight: String(weight),
        length: "20",
        width:  "15",
        height: "10",
        items:  buildItems(items)
      }
    });

    const couriers     = rateRes.data?.data?.couriers || rateRes.data?.data?.rates || rateRes.data?.rates || [];
    const requestToken = rateRes.data?.data?.request_token || "";

    if (!rateRes.ok || !couriers.length) {
      const msg = rateRes.data?.message || rateRes.data?.data?.message || rateRes.data?.errors?.[0] || "No couriers available";
      return res.status(200).json({ ok: false, error: `Shipbubble: ${msg}` });
    }

    const rates = couriers.map(r => ({
      courier_id:             r.courier_id    || "",
      courier_name:           r.courier_name  || "Courier",
      service_code:           r.service_code  || "",
      delivery_fee:           Number(r.total  || r.rate_card_amount || r.fee || 0),
      eta:                    r.delivery_eta  || r.estimated_days ? `${r.estimated_days} day(s)` : "2–5 days",
      logo:                   r.courier_image || r.courier_logo || "",
      request_token:          requestToken,
      recipient_address_code: recipReg.code,
      is_cod:                 r.is_cod_available || false
    }));

    return res.status(200).json({ ok: true, rates, request_token: requestToken });
  }

  // ══════════════════════════════════════════════════
  //  REGISTER SENDER ADDRESS (called from admin panel)
  //  Admin enters their address, we register it with
  //  Shipbubble and return the code to save in Vercel
  // ══════════════════════════════════════════════════
  if (action === "registerSender") {
    const { name, email, phone: p, address, city, state } = payload;
    if (!address || !city || !state) {
      return res.status(200).json({ ok: false, error: "Address, city and state are required" });
    }
    const r = await registerAddress({ name, email, phone: p, address, city, state });
    if (!r.ok) {
      const msg = r.raw?.data?.message || r.raw?.data?.errors?.[0] || "Could not register address";
      return res.status(200).json({ ok: false, error: msg, raw: r.raw?.data });
    }
    return res.status(200).json({
      ok:           true,
      address_code: r.code,
      message:      `Sender registered! Save this code in Vercel: SHIPBUBBLE_SENDER_CODE = ${r.code}`
    });
  }

  // ══════════════════════════════════════════════════
  //  BOOK SHIPMENT (admin confirms order)
  // ══════════════════════════════════════════════════
  if (action === "bookShipment") {
    const { order } = payload;
    if (!order) return res.status(400).json({ ok: false, error: "No order provided" });

    const senderCode = process.env.SHIPBUBBLE_SENDER_CODE || "";
    if (!senderCode) return res.status(200).json({ ok: false, error: "SHIPBUBBLE_SENDER_CODE not set in Vercel env vars" });

    const items = (() => {
      try { return typeof order.items === "string" ? JSON.parse(order.items) : (order.items || []); }
      catch { return []; }
    })();

    const weight = Math.max(0.5, items.reduce((s, i) => s + ((i.quantity || 1) * 0.3), 0));
    const isCOD  = order.payment_method === "cash_on_delivery";

    // Use saved recipient code or re-register
    let recipCode = order.shipbubble_recipient_code || "";
    if (!recipCode) {
      const reg = await registerAddress({
        name:    order.customer_name,
        email:   order.customer_email,
        phone:   order.customer_phone,
        address: order.delivery_street,
        city:    order.delivery_city,
        state:   order.delivery_state
      });
      if (!reg.ok) return res.status(200).json({ ok: false, error: "Could not register recipient address for booking" });
      recipCode = reg.code;
    }

    const category = getCategory(order.delivery_state);
    let   requestToken = order.shipbubble_request_token || "";

    if (!requestToken) {
      const rr = await sb("/shipping/fetch_rates", {
        sender_address_code:    senderCode,
        recipient_address_code: recipCode,
        package_category:       category,
        package: {
          weight: String(weight), length: "20", width: "15", height: "10",
          items:  buildItems(items)
        }
      });
      requestToken = rr.data?.data?.request_token || "";
      if (!requestToken) return res.status(200).json({ ok: false, error: "Could not get booking token from Shipbubble" });
    }

    const { ok, data } = await sb("/shipping/labels", {
      sender_address_code:    senderCode,
      recipient_address_code: recipCode,
      package_category:       category,
      package: {
        weight: String(weight), length: "20", width: "15", height: "10",
        items:  buildItems(items)
      },
      payment_type:  isCOD ? "COD" : "prepaid",
      ...(isCOD ? { cod_amount: Number(order.total || 0) } : {}),
      service_code:  order.shipbubble_service_code || "",
      courier_id:    order.shipbubble_courier_id   || "",
      request_token: requestToken
    });

    if (!ok || !data?.data) {
      return res.status(200).json({ ok: false, error: data?.message || "Shipbubble could not create shipment" });
    }
    const s = data.data;
    return res.status(200).json({
      ok:           true,
      tracking_id:  s.tracking_id  || s.id         || "",
      courier_name: s.courier_name || s.courier     || "",
      label_url:    s.label_url    || s.waybill_url || ""
    });
  }

  // ══════════════════════════════════════════════════
  //  DEBUG
  // ══════════════════════════════════════════════════
  if (action === "debug") {
    const senderCode = process.env.SHIPBUBBLE_SENDER_CODE || "NOT SET";

    // Test all address endpoints directly
    const addrBody = {
      name: "MC Store", email: "mcstore.care@gmail.com",
      phone: "+2348056230366",
      address: "Opposite Bovas Filling Station, Bodija",
      city: "Ibadan", state: "Oyo State", country: "NG"
    };
    const endpointTests = {};
    for (const ep of ["/shipping/sender-address", "/shipping/address", "/shipping/addresses"]) {
      const r = await sb(ep, addrBody);
      endpointTests[ep] = { status: r.status, ok: r.ok, data: r.data };
    }
    // Also try GET on sender-address to see existing ones
    const getR = await sb("/shipping/sender-address", {}, "GET");
    endpointTests["GET /shipping/sender-address"] = { status: getR.status, ok: getR.ok, data: getR.data };

    return res.status(200).json({
      api_key_prefix:    SHIPBUBBLE_KEY.slice(0, 20) + "...",
      sender_code_env:   senderCode,
      endpoint_tests:    endpointTests
    });
  }

  return res.status(400).json({ ok: false, error: `Unknown action: ${action}` });
    }
