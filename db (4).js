// ============================================================
//  db.js — MC Store Database (Fast Version)
//  Supabase anon key — RLS disabled on all tables
// ============================================================

const SB_URL  = "https://kswikkoqfpyxuurzxail.supabase.co";
const SB_ANON = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Imtzd2lra29xZnB5eHV1cnp4YWlsIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzEzNjEzMDQsImV4cCI6MjA4NjkzNzMwNH0.uuoSKWOTeXot1HJys0EO9OcIRBL0mKrNHIUHIAPCpZ4";

// ─────────────────────────────────────────
//  Lean fetch — no debug overhead
// ─────────────────────────────────────────
async function sb(endpoint, options = {}) {
  const res = await fetch(`${SB_URL}/rest/v1/${endpoint}`, {
    ...options,
    headers: {
      apikey:         SB_ANON,
      Authorization:  `Bearer ${SB_ANON}`,
      'Content-Type': 'application/json',
      ...(options.headers || {})
    }
  });
  if (!res.ok) {
    const err = await res.text();
    throw new Error(err);
  }
  const t = await res.text();
  return t ? JSON.parse(t) : null;
}

function normalise(p) {
  if (!p) return p;
  const name      = p.name || p.title || 'Unnamed Product';
  const image_url = p.image_url || (Array.isArray(p.images) && p.images[0]) || p.image || null;
  const price     = Number(p.price) || 0;
  const promo     = p.promo_price ? Number(p.promo_price) : 0;
  const hasPromo  = promo > 0 && promo < price;
  return { ...p, name, image_url,
    display_price:  hasPromo ? promo : price,
    original_price: hasPromo ? price : null
  };
}

// ============================================================
//  ── PRODUCTS ──
// ============================================================

export async function db_getProducts({ category, section, search, limit } = {}) {
  try {
    // is_active=eq.true OR is_active is null (old products without the field set)
    let q = 'products?select=*&is_active=not.eq.false&order=created_at.desc';
    if (category) q += `&category=eq.${encodeURIComponent(category)}`;
    if (section) {
      // add-product.html saves full names like "Featured Products", "New Arrivals", "Flash Deals"
      // Map short codes to full names for compatibility
      const sectionMap = {
        featured:     'Featured Products',
        new_arrivals: 'New Arrivals',
        flash_deals:  'Flash Deals',
      };
      const sectionVal = sectionMap[section] || section;
      q += `&section=eq.${encodeURIComponent(sectionVal)}`;
    }
    if (search) {
      // search both name and title columns
      q += `&or=(name.ilike.${encodeURIComponent('%'+search+'%')},title.ilike.${encodeURIComponent('%'+search+'%')})`;
    }
    if (limit) q += `&limit=${limit}`;
    return ((await sb(q)) || []).map(normalise);
  } catch(e) { console.error('getProducts:', e); return []; }
}

export async function db_getProductById(id) {
  try {
    const rows = await sb(`products?select=*&id=eq.${id}`);
    return rows?.length ? normalise(rows[0]) : null;
  } catch(e) { console.error('getProductById:', e); return null; }
}

// ============================================================
//  ── CART ──
//  FAST: uses UPSERT — one single call, no check-then-insert
// ============================================================

export async function db_getCart(uid) {
  try {
    return await sb(`cart?select=*&uid=eq.${uid}&order=added_at.desc`) || [];
  } catch(e) { console.error('getCart:', e); return []; }
}

export async function db_addToCart(uid, product, quantity = 1) {
  // UPSERT — if product already in cart, increase qty
  // One call instead of two = 2x faster
  const pid = String(product.id);
  await sb('cart', {
    method:  'POST',
    headers: { Prefer: 'resolution=merge-duplicates,return=minimal' },
    body: JSON.stringify({
      uid,
      product_id: pid,
      name:       product.name || product.title || '',
      image_url:  product.image_url || (Array.isArray(product.images) && product.images[0]) || '',
      price:      product.display_price || product.promo_price || product.price || 0,
      quantity,
      added_at:   new Date().toISOString()
    })
  });
  return { action: 'added' };
}

export async function db_updateCartQty(uid, productId, quantity) {
  if (quantity <= 0) return db_removeFromCart(uid, productId);
  await sb(`cart?uid=eq.${uid}&product_id=eq.${productId}`, {
    method: 'PATCH',
    body:   JSON.stringify({ quantity })
  });
}

export async function db_removeFromCart(uid, productId) {
  await sb(`cart?uid=eq.${uid}&product_id=eq.${productId}`, { method: 'DELETE' });
}

export async function db_clearCart(uid) {
  try { await sb(`cart?uid=eq.${uid}`, { method: 'DELETE' }); } catch(_) {}
}

export async function db_getCartCount(uid) {
  try {
    const items = await db_getCart(uid);
    return items.reduce((s, i) => s + (i.quantity || 1), 0);
  } catch { return 0; }
}

// ============================================================
//  ── WISHLIST ──
//  FAST: UPSERT with ignore-duplicates — one call
// ============================================================

export async function db_getWishlist(uid) {
  try {
    return await sb(`wishlist?select=*&uid=eq.${uid}&order=added_at.desc`) || [];
  } catch(e) { console.error('getWishlist:', e); return []; }
}

export async function db_addToWishlist(uid, product) {
  const pid = String(product.id);
  await sb('wishlist', {
    method:  'POST',
    headers: { Prefer: 'resolution=ignore-duplicates,return=minimal' },
    body: JSON.stringify({
      uid,
      product_id: pid,
      name:       product.name || product.title || '',
      image_url:  product.image_url || (Array.isArray(product.images) && product.images[0]) || '',
      price:      product.display_price || product.price || 0,
      added_at:   new Date().toISOString()
    })
  });
  return { action: 'added' };
}

export async function db_removeFromWishlist(uid, productId) {
  await sb(`wishlist?uid=eq.${uid}&product_id=eq.${productId}`, { method: 'DELETE' });
}

export async function db_isInWishlist(uid, productId) {
  try {
    const rows = await sb(`wishlist?uid=eq.${uid}&product_id=eq.${productId}&select=product_id`);
    return rows?.length > 0;
  } catch { return false; }
}

export async function db_getWishlistCount(uid) {
  try {
    const rows = await sb(`wishlist?uid=eq.${uid}&select=product_id`);
    return rows?.length || 0;
  } catch { return 0; }
}

// ============================================================
//  ── REVIEWS ──
// ============================================================

export async function db_getReviews(productId) {
  try {
    return await sb(`reviews?select=*&product_id=eq.${productId}&order=created_at.desc`) || [];
  } catch(e) { console.error('getReviews:', e); return []; }
}

export async function db_addReview({ uid, productId, userName, rating, comment }) {
  await sb('reviews', {
    method:  'POST',
    headers: { Prefer: 'return=minimal' },
    body: JSON.stringify({
      uid:           String(uid),
      product_id:    String(productId),
      user_name:     userName || 'Customer',
      customer_name: userName || 'Customer',
      rating:        Number(rating),
      comment:       comment || '',
      verified:      true,
      created_at:    new Date().toISOString()
    })
  });
  return true;
}

// ============================================================
//  ── ORDERS ──
// ============================================================

export async function db_placeOrder(orderData) {
  const year   = new Date().getFullYear();
  const num    = Math.floor(Math.random() * 900000) + 100000;
  const result = await sb('orders', {
    method:  'POST',
    headers: { Prefer: 'return=representation' },
    body: JSON.stringify({
      order_number:               `MC-${year}-${num}`,
      uid:                        String(orderData.uid),
      customer_name:              orderData.customerName    || '',
      customer_email:             orderData.customerEmail   || '',
      customer_phone:             orderData.customerPhone   || '',
      items:                      JSON.stringify(orderData.items || []),
      delivery_street:            orderData.deliveryStreet  || '',
      delivery_city:              orderData.deliveryCity    || '',
      delivery_state:             orderData.deliveryState   || '',
      delivery_landmark:          orderData.deliveryLandmark|| '',
      
      // FIX: Ensure these match the variables coming from your fixed Cart
      shipbubble_request_token:   orderData.shipbubble_request_token || '',
      shipbubble_courier_id:      orderData.shipbubble_courier_id   || '',
      shipbubble_courier_name:    orderData.shipbubble_courier_name || '',
      shipbubble_service_code:    orderData.shipbubble_service_code || '',
      
      payment_method:             orderData.paymentMethod   || 'paystack',
      payment_status:             orderData.paymentRef ? 'paid' : 'pending',
      payment_ref:                orderData.paymentRef      || '',
      status:                     'processing',
      subtotal:                   orderData.subtotal        || 0,
      delivery_fee:               orderData.delivery_fee    || orderData.deliveryFee || 0,
      discount:                   orderData.discount        || 0,
      total:                      orderData.total           || 0,
      created_at:                 new Date().toISOString(),
      updated_at:                 new Date().toISOString()
    })
  });

  // Fire and forget — don't wait for these to complete
  db_clearCart(orderData.uid);
  (orderData.items || []).forEach(async item => {
    try {
      const pid  = item.product_id || item.id;
      const rows = await sb(`products?select=stock&id=eq.${pid}`);
      if (rows?.length) {
        const newStock = Math.max(0, (rows[0].stock || 0) - (item.quantity || 1));
        await sb(`products?id=eq.${pid}`, {
          method: 'PATCH',
          body:   JSON.stringify({ stock: newStock })
        });
      }
    } catch(_) {}
  });

  return result?.[0] || result;
}

export async function db_getMyOrders(uid, limit = 50) {
  try {
    return await sb(`orders?select=*&uid=eq.${uid}&order=created_at.desc&limit=${limit}`) || [];
  } catch(e) { console.error('getMyOrders:', e); return []; }
}

export async function db_getAllOrders(limit = 200) {
  try {
    return await sb(`orders?select=*&order=created_at.desc&limit=${limit}`) || [];
  } catch(e) { console.error('getAllOrders:', e); return []; }
}

export async function db_updateOrderStatus(orderId, status) {
  await sb(`orders?id=eq.${orderId}`, {
    method: 'PATCH',
    body:   JSON.stringify({ status, updated_at: new Date().toISOString() })
  });
  return true;
}

// ============================================================
//  ── UTILS ──
// ============================================================
export function sid(id) {
  return id === null || id === undefined ? '' : String(id);
      }
    
