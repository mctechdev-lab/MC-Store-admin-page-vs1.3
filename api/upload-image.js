// api/upload-image.js — Cloudinary upload serverless function
// Handles product image uploads via Cloudinary

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ ok: false, error: 'Method not allowed' });

  try {
    const { image, fileName } = req.body;
    if (!image) return res.status(400).json({ ok: false, error: 'No image provided' });

    const CLOUD_NAME = 'dluuvtjph';
    const UPLOAD_PRESET = 'ml_default';

    // Upload to Cloudinary
    const formData = new URLSearchParams();
    formData.append('file', image);
    formData.append('upload_preset', UPLOAD_PRESET);
    formData.append('folder', 'mcstore/products');
    if (fileName) formData.append('public_id', `mcstore/products/${Date.now()}_${fileName.replace(/\.[^/.]+$/, '')}`);

    const response = await fetch(
      `https://api.cloudinary.com/v1_1/${CLOUD_NAME}/image/upload`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: formData.toString()
      }
    );

    const data = await response.json();

    if (!response.ok || data.error) {
      return res.status(400).json({ ok: false, error: data.error?.message || 'Upload failed' });
    }

    return res.status(200).json({
      ok: true,
      url: data.secure_url,
      public_id: data.public_id,
      width: data.width,
      height: data.height
    });

  } catch (err) {
    return res.status(500).json({ ok: false, error: err.message });
  }
}
