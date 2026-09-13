// ============================================================
//  api/sync-vendor-product.js
//  Syncs an approved vendor product into the main `products` table.
//  Runs server-side with the service role key — the `products` table's
//  RLS only allows writes from service_role, never the public anon key,
//  so this MUST happen here, not from the browser.
// ============================================================

const SUPA_URL = 'https://kswikkoqfpyxuurzxail.supabase.co';
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

async function sb(path, options = {}) {
  const res = await fetch(`${SUPA_URL}/rest/v1/${path}`, {
    ...options,
    headers: {
      apikey: SERVICE_KEY,
      Authorization: `Bearer ${SERVICE_KEY}`,
      'Content-Type': 'application/json',
      Prefer: options.method === 'POST' ? 'return=representation' : 'return=minimal',
      ...(options.headers || {})
    }
  });
  if (!res.ok) throw new Error(await res.text());
  const text = await res.text();
  return text ? JSON.parse(text) : null;
}

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ ok: false, error: 'Method not allowed' });

  if (!SERVICE_KEY) {
    return res.status(500).json({ ok: false, error: 'SUPABASE_SERVICE_ROLE_KEY not set in Vercel env vars' });
  }

  try {
    const { action, vendorProduct } = req.body;
    if (!vendorProduct?.id) return res.status(400).json({ ok: false, error: 'Missing vendorProduct' });

    if (action === 'sync') {
      const shared = {
        title: vendorProduct.name || '', name: vendorProduct.name || '',
        price: Number(vendorProduct.price) || 0,
        stock: Number(vendorProduct.stock) || 0,
        category: vendorProduct.category || 'Others',
        description: vendorProduct.description || null,
        images: vendorProduct.images || [],
        is_active: true,
        vendor_id: vendorProduct.vendor_id,
        vendor_product_id: vendorProduct.id, // ties this row to exactly one vendor product — enforced unique in the DB
        variants: vendorProduct.variants || null,
        attributes: vendorProduct.attributes || null,
        delivery_method: vendorProduct.delivery_method || 'shipbubble'
      };

      // Atomic upsert keyed on vendor_product_id — whether this is the 1st
      // or 5th retry, whether an earlier attempt partially failed or not,
      // this can NEVER create a duplicate row. Postgres enforces it.
      const [row] = await sb(`products?on_conflict=vendor_product_id`, {
        method: 'POST',
        headers: { Prefer: 'resolution=merge-duplicates,return=representation' },
        body: JSON.stringify(shared)
      });
      const mcId = row.id;

      if (vendorProduct.mc_store_product_id !== mcId) {
        await sb(`vendor_products?id=eq.${vendorProduct.id}`, { method: 'PATCH', body: JSON.stringify({ mc_store_product_id: mcId }) });
      }

      return res.status(200).json({ ok: true, mc_store_product_id: mcId });
    }

    if (action === 'unsync') {
      await sb(`products?vendor_product_id=eq.${vendorProduct.id}`, { method: 'PATCH', body: JSON.stringify({ is_active: false }) });
      return res.status(200).json({ ok: true });
    }

    return res.status(400).json({ ok: false, error: 'Unknown action' });
  } catch (err) {
    return res.status(500).json({ ok: false, error: err.message });
  }
};
