// api/add-product.js — Complete product upload serverless function
// Handles: Image upload to Cloudinary + Save to Supabase database

const CLOUD_NAME = 'dluuvtjph';
const UPLOAD_PRESET = 'ml_default';
const SB_URL = 'https://kswikkoqfpyxuurzxail.supabase.co';
const SB_SERVICE_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Imtzd2lra29xZnB5eHV1cnp4YWlsIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc3MTM2MTMwNCwiZXhwIjoyMDg2OTM3MzA0fQ.Z5UvrKaNwUB2fPbcGRnSkw773X7oL9kE3u5PbUay9mI';

// Upload single image to Cloudinary
async function uploadToCloudinary(base64Image, fileName) {
  const formData = new URLSearchParams();
  formData.append('file', base64Image);
  formData.append('upload_preset', UPLOAD_PRESET);
  formData.append('folder', 'mcstore/products');

  const res = await fetch(
    `https://api.cloudinary.com/v1_1/${CLOUD_NAME}/image/upload`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: formData.toString()
    }
  );

  const data = await res.json();
  if (!res.ok || data.error) throw new Error(data.error?.message || 'Cloudinary upload failed');
  return data.secure_url;
}

// Save product to Supabase using service role key
async function saveToSupabase(product) {
  const res = await fetch(`${SB_URL}/rest/v1/products`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'apikey': SB_SERVICE_KEY,
      'Authorization': `Bearer ${SB_SERVICE_KEY}`,
      'Prefer': 'return=representation'
    },
    body: JSON.stringify(product)
  });

  const data = await res.json();
  if (!res.ok) throw new Error(data.message || data.error || 'Database save failed');
  return data;
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ ok: false, error: 'Method not allowed' });

  try {
    const { action, images, product } = req.body || {};

    // ── UPLOAD IMAGES ──
    if (action === 'uploadImages') {
      if (!images || !images.length) {
        return res.status(400).json({ ok: false, error: 'No images provided' });
      }

      const urls = [];
      for (let i = 0; i < images.length; i++) {
        const url = await uploadToCloudinary(images[i].base64, images[i].name);
        urls.push(url);
      }

      return res.status(200).json({ ok: true, urls });
    }

    // ── SAVE PRODUCT ──
    if (action === 'saveProduct') {
      if (!product) return res.status(400).json({ ok: false, error: 'No product data' });

      const row = {
        title:       product.title,
        name:        product.title,
        price:       Number(product.price),
        promo_price: product.promo_price ? Number(product.promo_price) : null,
        stock:       Number(product.stock) || 0,
        weight:      Number(product.weight) || 0.5,
        category:    product.category,
        condition:   product.condition,
        description: product.description || null,
        image_url:   product.images?.[0] || null,
        images:      product.images || [],
        is_active:   true,
        is_featured: product.section === 'Featured Products',
        section:     product.section || 'Normal',
        discount:    product.section === 'Flash Deals' ? 10 : 0,
        created_at:  new Date().toISOString(),
        updated_at:  new Date().toISOString()
      };

      const saved = await saveToSupabase(row);
      return res.status(200).json({ ok: true, product: saved });
    }

    // ── UPLOAD + SAVE ALL IN ONE ──
    if (action === 'addProduct') {
      if (!images || !images.length) {
        return res.status(400).json({ ok: false, error: 'No images provided' });
      }
      if (!product) return res.status(400).json({ ok: false, error: 'No product data' });

      // Upload all images
      const imageUrls = [];
      for (let i = 0; i < images.length; i++) {
        const url = await uploadToCloudinary(images[i].base64, images[i].name);
        imageUrls.push(url);
      }

      // Save to database
      const row = {
        title:       product.title,
        name:        product.title,
        price:       Number(product.price),
        promo_price: product.promo_price ? Number(product.promo_price) : null,
        stock:       Number(product.stock) || 0,
        weight:      Number(product.weight) || 0.5,
        category:    product.category,
        condition:   product.condition,
        description: product.description || null,
        image_url:   imageUrls[0] || null,
        images:      imageUrls,
        is_active:   true,
        is_featured: product.section === 'Featured Products',
        section:     product.section || 'Normal',
        discount:    product.section === 'Flash Deals' ? 10 : 0,
        created_at:  new Date().toISOString(),
        updated_at:  new Date().toISOString()
      };

      const saved = await saveToSupabase(row);
      return res.status(200).json({ ok: true, product: saved, images: imageUrls });
    }

    return res.status(400).json({ ok: false, error: 'Unknown action' });

  } catch (err) {
    console.error('add-product error:', err);
    return res.status(500).json({ ok: false, error: err.message });
  }
}
