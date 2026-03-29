// ============================================================
//  api/shipping.js — Vercel Serverless Function
//  Proxies ALL Shipbubble calls server-side (no CORS issues)
//  Store keys never exposed to browser
// ============================================================

const SHIPBUBBLE_KEY  = process.env.SHIPBUBBLE_KEY || "sb_sandbox_f1d7ab8f1d6e69df77c93527811973001404cdc0c23d9aa7ef36ed4cb7ad3995";
const SHIPBUBBLE_BASE = "https://api.shipbubble.com/v1";

const STORE = {
  name:    "MC Store",
  email:   "mcstore.care@gmail.com",
  phone:   "08056230366",
  address: "Opposite Bovas Filling Station, Bodija, Ibadan, Oyo State, Nigeria",
  city:    "Ibadan",
  state:   "Oyo",
  country: "NG"
};

// ── Call Shipbubble API ──
async function shipbubble(path, body) {
  const res = await fetch(`${SHIPBUBBLE_BASE}${path}`, {
    method:  'POST',
    headers: {
      Authorization:  `Bearer ${SHIPBUBBLE_KEY}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(body)
  });
  const data = await res.json();
  return { ok: res.ok, data, status: res.status };
}

// ── FLAT RATE FALLBACK (when Shipbubble fails or sandbox) ──
function flatRates(state = '') {
  const s = (state || '').toLowerCase();
  if (s.includes('oyo'))
    return [
      { courier_id:'local-express',   courier_name:'Express Delivery',   delivery_fee:1500, eta:'Same day / Next day',    logo:'' },
      { courier_id:'local-standard',  courier_name:'Standard Delivery',  delivery_fee:800,  eta:'1-2 business days',      logo:'' }
    ];
  if (s.includes('lagos'))
    return [
      { courier_id:'lagos-express',   courier_name:'Express Delivery',   delivery_fee:3500, eta:'1-2 business days',      logo:'' },
      { courier_id:'lagos-standard',  courier_name:'Standard Delivery',  delivery_fee:2000, eta:'2-3 business days',      logo:'' }
    ];
  if (s.includes('abuja') || s.includes('fct'))
    return [
      { courier_id:'abuja-express',   courier_name:'Express Delivery',   delivery_fee:4000, eta:'2-3 business days',      logo:'' },
      { courier_id:'abuja-standard',  courier_name:'Standard Delivery',  delivery_fee:2500, eta:'3-5 business days',      logo:'' }
    ];
  if (['osun','ondo','ekiti','ogun','kwara','kogi','edo'].some(x => s.includes(x)))
    return [
      { courier_id:'sw-express',      courier_name:'Express Delivery',   delivery_fee:2500, eta:'1-3 business days',      logo:'' },
      { courier_id:'sw-standard',     courier_name:'Standard Delivery',  delivery_fee:1500, eta:'2-4 business days',      logo:'' }
    ];
  if (['rivers','delta','anambra','imo','enugu','abia','akwa'].some(x => s.includes(x)))
    return [
      { courier_id:'ss-express',      courier_name:'Express Delivery',   delivery_fee:4500, eta:'2-4 business days',      logo:'' },
      { courier_id:'ss-standard',     courier_name:'Standard Delivery',  delivery_fee:2800, eta:'3-5 business days',      logo:'' }
    ];
  // Rest of Nigeria
  return [
    { courier_id:'ng-express',        courier_name:'Express Delivery',   delivery_fee:5500, eta:'3-5 business days',      logo:'' },
    { courier_id:'ng-standard',       courier_name:'Standard Delivery',  delivery_fee:3500, eta:'5-7 business days',      logo:'' }
  ];
}

// ── MAIN HANDLER ──
export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST')   return res.status(405).json({ ok: false, error: 'Method not allowed' });

  const { action, payload = {} } = req.body || {};

  try {

    // ── GET RATES ──
    if (action === 'getRates') {
      const { recipientAddress, items = [], totalWeight = 0.5 } = payload;

      const { ok, data } = await shipbubble('/shipping/fetch-rates', {
        sender: STORE,
        recipient: {
          name:    recipientAddress.fullName || 'Customer',
          email:   recipientAddress.email    || '',
          phone:   recipientAddress.phone    || '',
          address: recipientAddress.street   || '',
          city:    recipientAddress.city     || '',
          state:   recipientAddress.state    || '',
          country: 'NG'
        },
        package: {
          weight: totalWeight || 0.5,
          length: 20, width: 15, height: 10,
          items: items.map(i => ({
            name:     i.name     || 'Item',
            quantity: i.quantity || 1,
            weight:   i.weight   || 0.3
          }))
        }
      });

      const rawRates = ok ? (data.data || data.rates || []) : [];

      if (!rawRates.length) {
        // Shipbubble failed or returned nothing — use flat rates
        return res.status(200).json({
          ok: true,
          rates: flatRates(recipientAddress.state),
          source: 'fallback'
        });
      }

      const rates = rawRates.map(r => ({
        courier_id:    r.courier_id    || r.id    || '',
        courier_name:  r.courier_name  || r.name  || 'Courier',
        service_code:  r.service_code  || r.code  || '',
        delivery_fee:  Number(r.total  || r.fee   || r.amount || 0),
        eta:           r.estimated_days ? `${r.estimated_days} business day(s)` : (r.eta || '2-5 days'),
        logo:          r.courier_logo  || r.logo  || ''
      }));

      return res.status(200).json({ ok: true, rates, source: 'shipbubble' });
    }

    // ── BOOK SHIPMENT (called by admin when confirming order) ──
    if (action === 'bookShipment') {
      const { order } = payload;

      const items = (() => {
        try { return typeof order.items === 'string' ? JSON.parse(order.items) : (order.items || []); }
        catch { return []; }
      })();

      const weight = Math.max(0.5, items.reduce((s, i) => s + ((i.quantity || 1) * 0.3), 0));

      const isCOD = order.payment_method === 'cash_on_delivery';

      const shipmentBody = {
        sender: STORE,
        recipient: {
          name:    order.customer_name  || 'Customer',
          email:   order.customer_email || '',
          phone:   order.customer_phone || '',
          address: order.delivery_street || '',
          city:    order.delivery_city   || '',
          state:   order.delivery_state  || '',
          country: 'NG'
        },
        package: {
          weight,
          length: 20, width: 15, height: 10,
          items: items.map(i => ({
            name:     i.name     || 'Item',
            quantity: i.quantity || 1,
            weight:   0.3
          }))
        },
        ...(order.shipbubble_service_code ? { service_code: order.shipbubble_service_code } : {}),
        // ── COD: tell Shipbubble to collect cash on delivery ──
        ...(isCOD ? {
          payment_type: 'COD',
          cod_amount:   Number(order.total || 0)
        } : {
          payment_type: 'prepaid'
        })
      };

      const { ok, data } = await shipbubble('/shipping/shipments', shipmentBody);

      if (!ok || !data.data) {
        // Shipbubble failed (sandbox/key issue) — mark shipped anyway so order moves forward
        console.log('[shipping] Shipbubble bookShipment failed:', data.message || 'no data');
        return res.status(200).json({
          ok:           true,
          tracking_id:  '',
          courier_name: 'Manual',
          eta:          '2-5 business days',
          label_url:    '',
          note:         'Booked manually — ' + (data.message || 'Shipbubble unavailable')
        });
      }

      const s = data.data;
      return res.status(200).json({
        ok:           true,
        tracking_id:  s.tracking_id  || s.id        || '',
        courier_name: s.courier_name || s.courier    || '',
        eta:          s.eta          || '2-5 business days',
        label_url:    s.label_url    || s.waybill_url || ''
      });
    }

    return res.status(400).json({ ok: false, error: `Unknown action: ${action}` });

  } catch(e) {
    console.error('[api/shipping]', e.message);
    // Always return something so checkout never breaks
    return res.status(200).json({
      ok:     true,
      rates:  flatRates(payload?.recipientAddress?.state || ''),
      source: 'fallback',
      error:  e.message
    });
  }
}
