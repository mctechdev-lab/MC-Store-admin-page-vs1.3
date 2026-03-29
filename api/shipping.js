// ============================================================
//  api/shipping.js — Vercel Serverless Function (FINAL BULLETPROOF VERSION)
//  ✅ FIXED: Uses request_token from order data when booking shipments
//  ✅ FIXED: Auto-fetches rates if request_token is missing
//  Uses standard 'https' module for maximum compatibility
// ============================================================

const https = require('https');

const SHIPBUBBLE_KEY  = process.env.SHIPBUBBLE_KEY;
const SHIPBUBBLE_HOST = "api.shipbubble.com";

const STORE = {
  name:    "MC Store",
  email:   "mcstore.care@gmail.com",
  phone:   "08056230366",
  address: "Opposite Bovas Filling Station, Bodija, Ibadan, Oyo State, Nigeria",
  city:    "Ibadan",
  state:   "Oyo",
  country: "NG"
};

// ── Robust HTTPS Request Helper ──
function shipbubbleRequest(path, method, body) {
  return new Promise((resolve, reject) => {
    const dataString = body ? JSON.stringify(body) : '';
    
    const options = {
      hostname: SHIPBUBBLE_HOST,
      port: 443,
      path: `/v1${path}`,
      method: method,
      headers: {
        'Authorization': `Bearer ${SHIPBUBBLE_KEY}`,
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(dataString)
      },
      timeout: 15000
    };

    const req = https.request(options, (res) => {
      let responseBody = '';
      res.on('data', (chunk) => { responseBody += chunk; });
      res.on('end', () => {
        try {
          const parsedData = JSON.parse(responseBody);
          resolve({ ok: res.statusCode >= 200 && res.statusCode < 300, data: parsedData, status: res.statusCode });
        } catch (e) {
          resolve({ ok: false, data: { message: 'Invalid JSON response from Shipbubble' }, status: res.statusCode });
        }
      });
    });

    req.on('error', (e) => {
      reject(new Error(`Network error: ${e.message}`));
    });

    req.on('timeout', () => {
      req.destroy();
      reject(new Error('Request timed out'));
    });

    if (dataString) req.write(dataString);
    req.end();
  });
}

// ── MAIN HANDLER ──
module.exports = async (req, res) => {
  // CORS Headers
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS, GET');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  
  if (req.method === 'OPTIONS') return res.status(200).end();
  
  const { action, payload = {} } = req.body || {};

  try {
    // ── GET WALLET BALANCE ──
    if (action === 'getWallet') {
      const { ok, data } = await shipbubbleRequest('/shipping/wallet/balance', 'GET');
      if (!ok) return res.status(200).json({ ok: false, error: data.message || 'Could not fetch wallet' });
      
      let balance = data?.data?.balance ?? data?.balance ?? null;
      if (balance === null) return res.status(200).json({ ok: false, error: 'Balance not found in response' });
      
      return res.status(200).json({ ok: true, balance: Number(balance) });
    }

    // ── GET RATES (called by customer during checkout) ──
    if (action === 'getRates') {
      const { recipientAddress, items = [], totalWeight = 0.5 } = payload;
      
      const rateBody = {
        sender: STORE,
        recipient: {
          name: recipientAddress.fullName || 'Customer',
          email: recipientAddress.email || '',
          phone: recipientAddress.phone || '',
          address: recipientAddress.street || '',
          city: recipientAddress.city || '',
          state: recipientAddress.state || '',
          country: 'NG'
        },
        package: {
          weight: totalWeight || 0.5,
          length: 20, width: 15, height: 10,
          items: items.map(i => ({
            name: i.name || 'Item',
            quantity: i.quantity || 1,
            weight: i.weight || 0.3
          }))
        }
      };

      const { ok, data } = await shipbubbleRequest('/shipping/fetch_rates', 'POST', rateBody);
      
      const rawRates = ok ? (data.data || data.rates || []) : [];
      
      if (!rawRates.length) {
        // Fallback to flat rates
        return res.status(200).json({
          ok: true,
          rates: flatRates(recipientAddress.state),
          source: 'fallback'
        });
      }

      // ✅ FIXED: Include request_token in the rates response so customer can save it
      const rates = rawRates.map(r => ({
        courier_id: r.courier_id || r.id || '',
        courier_name: r.courier_name || r.name || 'Courier',
        service_code: r.service_code || r.code || '',
        delivery_fee: Number(r.total || r.fee || r.amount || 0),
        eta: r.estimated_days ? `${r.estimated_days} business day(s)` : '2-5 business days',
        request_token: data.data?.request_token || data.request_token || '', // ✅ Include request_token!
        logo: r.courier_logo || r.logo || ''
      }));

      return res.status(200).json({ ok: true, rates, source: 'shipbubble' });
    }

    // ── BOOK SHIPMENT (called by admin when confirming order) ──
    if (action === 'bookShipment') {
      const { order } = payload;
      if (!order) return res.status(400).json({ ok: false, error: 'Order data missing' });

      const items = (() => {
        try { return typeof order.items === 'string' ? JSON.parse(order.items) : (order.items || []); }
        catch { return []; }
      })();

      const isCOD = order.payment_method === 'cash_on_delivery';
      
      // ✅ FIXED: Extract request_token from order (saved during checkout)
      let requestToken = order.shipbubble_request_token || order.request_token;
      let serviceCode = order.shipbubble_service_code || order.service_code;
      let courierId = order.shipbubble_courier_id || order.courier_id;

      // If request_token is missing, auto-fetch rates
      if (!requestToken) {
        console.log("[shipping.js] No request_token found. Auto-fetching rates...");
        
        const rateBody = {
          sender: STORE,
          recipient: {
            name: order.customer_name || 'Customer',
            email: order.customer_email || 'no-email@provided.com',
            phone: order.customer_phone || '',
            address: order.delivery_street || '',
            city: order.delivery_city || '',
            state: order.delivery_state || '',
            country: 'NG'
          },
          package: {
            weight: Math.max(0.5, items.reduce((s, i) => s + ((i.quantity || 1) * (i.weight || 0.3)), 0)),
            length: 20, width: 15, height: 10,
            items: items.map(i => ({
              name: i.name || 'Item',
              quantity: i.quantity || 1,
              weight: i.weight || 0.3
            }))
          }
        };

        const rateRes = await shipbubbleRequest('/shipping/fetch_rates', 'POST', rateBody);
        
        if (!rateRes.ok) {
          return res.status(200).json({ ok: false, error: "Failed to auto-fetch rates: " + (rateRes.data.message || 'Requested resource not available') });
        }

        requestToken = rateRes.data?.data?.request_token;
        const rates = rateRes.data?.data?.rates || rateRes.data?.data?.couriers || [];
        
        if (!requestToken || rates.length === 0) {
          return res.status(200).json({ ok: false, error: "No shipping rates available for this address" });
        }

        // Auto-select first rate if none was provided
        if (!serviceCode) {
          serviceCode = rates[0].service_code;
          courierId = rates[0].courier_id;
          console.log(`[shipping.js] Auto-selected rate: ${rates[0].courier_name}`);
        }
      }

      // Build shipment request
      const shipmentBody = {
        sender: STORE,
        recipient: {
          name: order.customer_name || 'Customer',
          email: order.customer_email || 'no-email@provided.com',
          phone: order.customer_phone || '',
          address: order.delivery_street || '',
          city: order.delivery_city || '',
          state: order.delivery_state || '',
          country: 'NG'
        },
        package: {
          weight: Math.max(0.5, items.reduce((s, i) => s + ((i.quantity || 1) * (i.weight || 0.3)), 0)),
          length: 20, width: 15, height: 10,
          items: items.map(i => ({
            name: i.name || 'Item',
            quantity: i.quantity || 1,
            weight: i.weight || 0.3
          }))
        },
        payment_type: isCOD ? 'COD' : 'prepaid',
        ...(isCOD ? { cod_amount: Number(order.total || 0) } : {}),
        service_code: serviceCode,
        courier_id: courierId,
        request_token: requestToken,
        is_cod_label: isCOD
      };

      const { ok, data, status } = await shipbubbleRequest('/shipping/labels', 'POST', shipmentBody);

      if (!ok) {
        let errorMsg = data?.message || data?.error || 'Shipbubble API Error';
        if (data?.errors) errorMsg += ": " + JSON.stringify(data.errors);
        return res.status(200).json({ ok: false, error: errorMsg });
      }

      const shipmentData = data?.data || data;
      return res.status(200).json({
        ok: true,
        tracking_id: shipmentData.tracking_id || shipmentData.id,
        courier_name: shipmentData.courier_name || 'Courier',
        label_url: shipmentData.label_url || shipmentData.waybill_url || ''
      });
    }

    return res.status(400).json({ ok: false, error: `Unknown action: ${action}` });
  } catch(e) {
    console.error('[api/shipping] Fatal Error:', e.message);
    return res.status(500).json({ ok: false, error: 'Internal Server Error: ' + e.message });
  }
};

// ── FLAT RATE FALLBACK ──
function flatRates(state = '') {
  const s = (state || '').toLowerCase();
  if (s.includes('oyo'))
    return [
      { courier_id:'local-express', courier_name:'Express Delivery', service_code:'express', delivery_fee:1500, eta:'Same day / Next day', request_token: null },
      { courier_id:'local-standard', courier_name:'Standard Delivery', service_code:'standard', delivery_fee:800, eta:'1-2 business days', request_token: null }
    ];
  if (s.includes('lagos'))
    return [
      { courier_id:'lagos-express', courier_name:'Express Delivery', service_code:'express', delivery_fee:3500, eta:'1-2 business days', request_token: null },
      { courier_id:'lagos-standard', courier_name:'Standard Delivery', service_code:'standard', delivery_fee:2000, eta:'2-3 business days', request_token: null }
    ];
  if (s.includes('abuja') || s.includes('fct'))
    return [
      { courier_id:'abuja-express', courier_name:'Express Delivery', service_code:'express', delivery_fee:4000, eta:'2-3 business days', request_token: null },
      { courier_id:'abuja-standard', courier_name:'Standard Delivery', service_code:'standard', delivery_fee:2500, eta:'3-5 business days', request_token: null }
    ];
  // Default for rest of Nigeria
  return [
    { courier_id:'ng-express', courier_name:'Express Delivery', service_code:'express', delivery_fee:5500, eta:'3-5 business days', request_token: null },
    { courier_id:'ng-standard', courier_name:'Standard Delivery', service_code:'standard', delivery_fee:3500, eta:'5-7 business days', request_token: null }
  ];
          }
                                     
