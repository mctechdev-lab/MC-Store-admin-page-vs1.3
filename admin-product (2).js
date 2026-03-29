// ============================================================
//  admin-product.js — MC Store Admin Product Management
//  Works with: add-product.html, product-manager.html
//  Database:   Supabase (products table + product-images bucket)
//  Auth:       Supabase Admin Session (set by admin-index.html)
//
//  HOW TO USE IN ANY ADMIN HTML FILE:
//  <script src="https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2"></script>
//  <script type="module">
//    import { addProduct, editProduct, deleteProduct, getProducts } from './admin-product.js';
//  </script>
// ============================================================

const SUPABASE_URL = "https://kswikkoqfpyxuurzxail.supabase.co";
const SUPABASE_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Imtzd2lra29xZnB5eHV1cnp4YWlsIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzEzNjEzMDQsImV4cCI6MjA4NjkzNzMwNH0.uuoSKWOTeXot1HJys0EO9OcIRBL0mKrNHIUHIAPCpZ4";

// Supabase client — reused across all calls
const _sb = window.supabase.createClient(SUPABASE_URL, SUPABASE_KEY);


// ============================================================
//  CATEGORIES — single source of truth for the whole admin
//  Used by add-product.html and product-manager.html dropdowns
// ============================================================
export const CATEGORIES = [
  { name: "Electronics",            icon: "💻" },
  { name: "Mobile Phones",          icon: "📱" },
  { name: "Phone Accessories",      icon: "🎧" },
  { name: "Laptops or accessories", icon: "🖥️" },
  { name: "Tablets",                icon: "📲" },
  { name: "Cameras",                icon: "📷" },
  { name: "Home Appliances",        icon: "🏠" },
  { name: "Fashion",                icon: "👗" },
  { name: "Shoes",                  icon: "👟" },
  { name: "Bags & Accessories",     icon: "👜" },
  { name: "Sports & Outdoors",      icon: "⚽" },
  { name: "Toys & Games",           icon: "🎮" },
  { name: "Books & Stationery",     icon: "📚" },
  { name: "Cars & Vehicles",        icon: "🚗" },
  { name: "Others",                 icon: "📦" },
];

export const CATEGORY_NAMES = CATEGORIES.map(c => c.name);


// ============================================================
//  CONDITIONS
// ============================================================
export const CONDITIONS = [
  { name: "New",       desc: "Brand new, never used, original packaging" },
  { name: "Like New",  desc: "Used once or twice, no visible wear" },
  { name: "Excellent", desc: "Minor signs of use, fully functional" },
  { name: "Good",      desc: "Some wear but works perfectly" },
  { name: "Fair",      desc: "Noticeable wear, still functional" },
  { name: "Used",      desc: "Heavy use, sold as-is" },
];

export const CONDITION_NAMES = CONDITIONS.map(c => c.name);


// ============================================================
//  AUTH GUARD
//  Every write operation (add/edit/delete) calls this first.
//  Throws if admin is not logged in.
// ============================================================
async function requireAdminSession() {
  const { data, error } = await _sb.auth.getSession();
  if (error || !data.session) {
    throw new Error("Admin session expired. Please log in again.");
  }
  return data.session;
}


// ============================================================
//  UPLOAD SINGLE IMAGE
//  Uploads one File to Supabase Storage → product-images bucket
//  Returns: public URL string
// ============================================================
export async function uploadProductImage(file, productId = null) {
  const session = await requireAdminSession();

  if (!file || !file.type.startsWith("image/")) {
    throw new Error("Invalid file. Please upload an image.");
  }
  if (file.size > 5 * 1024 * 1024) {
    throw new Error("Image must be under 5 MB.");
  }

  const ext      = file.name.split(".").pop().toLowerCase();
  const uid      = session.user.id;
  const folder   = productId ? `products/${productId}` : `products/new/${uid}`;
  const fileName = `${folder}/${Date.now()}_${Math.random().toString(36).slice(2, 8)}.${ext}`;

  const { error: upErr } = await _sb.storage
    .from("product-images")
    .upload(fileName, file, { cacheControl: "3600", upsert: false });

  if (upErr) throw new Error("Image upload failed: " + upErr.message);

  const { data: { publicUrl } } = _sb.storage
    .from("product-images")
    .getPublicUrl(fileName);

  return publicUrl;
}


// ============================================================
//  UPLOAD MULTIPLE IMAGES
//  Loops through files[], uploads each one.
//  onProgress(current, total) called after each upload.
//  Returns: array of public URL strings
// ============================================================
export async function uploadProductImages(files, productId = null, onProgress = null) {
  const urls = [];
  for (let i = 0; i < files.length; i++) {
    const url = await uploadProductImage(files[i], productId);
    urls.push(url);
    if (typeof onProgress === "function") onProgress(i + 1, files.length);
  }
  return urls;
}


// ============================================================
//  ADD PRODUCT
//  Creates a new product in Supabase products table.
//
//  Usage:
//    await addProduct({
//      title: "iPhone 14",
//      price: 450000,
//      category: "Mobile Phones",
//      condition: "New",
//      description: "Brand new sealed box",
//      imageFiles: [file1, file2],   // File objects from input
//      stock: 5,
//    });
// ============================================================
export async function addProduct({
  title,
  price,
  category,
  condition,
  description  = "",
  imageFiles   = [],    // File[] — will be uploaded automatically
  imageUrls    = [],    // string[] — already-uploaded URLs (optional)
  stock        = 1,
  onProgress   = null,
}) {
  // Validate required fields
  if (!title?.trim())                   throw new Error("Product title is required.");
  if (!price || Number(price) <= 0)     throw new Error("Please enter a valid price.");
  if (!CATEGORY_NAMES.includes(category))  throw new Error("Please select a valid category.");
  if (!CONDITION_NAMES.includes(condition)) throw new Error("Please select a valid condition.");

  const session = await requireAdminSession();

  // Upload new images
  let allUrls = [...imageUrls];
  if (imageFiles.length > 0) {
    const uploaded = await uploadProductImages(imageFiles, null, onProgress);
    allUrls = [...allUrls, ...uploaded];
  }
  if (allUrls.length === 0) throw new Error("Please add at least one product image.");

  // Save to Supabase
  const { data, error } = await _sb.from("products").insert([{
    title:       title.trim(),
    price:       parseFloat(price),
    category,
    condition,
    description: description.trim(),
    images:      allUrls,
    stock:       parseInt(stock) || 1,
    is_active:   true,
    user_id:     session.user.id,
    created_at:  new Date().toISOString(),
  }]).select().single();

  if (error) throw new Error("Failed to add product: " + error.message);
  return data;
}


// ============================================================
//  EDIT PRODUCT
//  Updates an existing product by its ID.
//  Only pass the fields you want to change.
//
//  Usage:
//    await editProduct("product-uuid", {
//      title: "New Title",
//      price: 500000,
//      newImageFiles: [file],     // adds new images
//      existingUrls: ["https://..."], // keeps these old images
//    });
// ============================================================
export async function editProduct(productId, {
  title,
  price,
  category,
  condition,
  description,
  newImageFiles = [],     // File[] — new images to upload
  existingUrls  = [],     // string[] — old image URLs to keep
  stock,
  is_active,
  onProgress    = null,
} = {}) {
  if (!productId) throw new Error("Product ID is required.");
  await requireAdminSession();

  const updates = {};
  if (title       !== undefined) updates.title       = title.trim();
  if (price       !== undefined) updates.price       = parseFloat(price);
  if (description !== undefined) updates.description = description.trim();
  if (stock       !== undefined) updates.stock       = parseInt(stock);
  if (is_active   !== undefined) updates.is_active   = Boolean(is_active);

  if (category !== undefined) {
    if (!CATEGORY_NAMES.includes(category)) throw new Error("Invalid category.");
    updates.category = category;
  }
  if (condition !== undefined) {
    if (!CONDITION_NAMES.includes(condition)) throw new Error("Invalid condition.");
    updates.condition = condition;
  }

  // Handle images — upload new ones and merge with kept existing ones
  if (newImageFiles.length > 0) {
    const uploaded    = await uploadProductImages(newImageFiles, productId, onProgress);
    updates.images    = [...existingUrls, ...uploaded];
  } else if (existingUrls.length > 0) {
    updates.images    = existingUrls;
  }

  updates.updated_at = new Date().toISOString();

  const { data, error } = await _sb
    .from("products")
    .update(updates)
    .eq("id", productId)
    .select()
    .single();

  if (error) throw new Error("Failed to update product: " + error.message);
  return data;
}


// ============================================================
//  DELETE PRODUCT
//  Permanently removes a product from Supabase.
//
//  Usage:
//    await deleteProduct("product-uuid");
// ============================================================
export async function deleteProduct(productId) {
  if (!productId) throw new Error("Product ID is required.");
  await requireAdminSession();

  const { error } = await _sb
    .from("products")
    .delete()
    .eq("id", productId);

  if (error) throw new Error("Failed to delete product: " + error.message);
  return { success: true, id: productId };
}


// ============================================================
//  TOGGLE PRODUCT STATUS — active or inactive
//  Inactive products are hidden from the storefront
//  but NOT deleted. Good for out-of-season items.
// ============================================================
export async function toggleProductStatus(productId, isActive) {
  if (!productId) throw new Error("Product ID is required.");
  await requireAdminSession();

  const { data, error } = await _sb
    .from("products")
    .update({ is_active: Boolean(isActive), updated_at: new Date().toISOString() })
    .eq("id", productId)
    .select()
    .single();

  if (error) throw new Error("Failed to update product status: " + error.message);
  return data;
}


// ============================================================
//  GET ALL PRODUCTS
//  Fetch products with optional filters.
//
//  Usage:
//    const products = await getProducts({ category: "Fashion" });
//    const products = await getProducts({ search: "iphone", is_active: true });
// ============================================================
export async function getProducts({
  category  = null,
  condition = null,
  is_active = null,
  search    = null,
  limit     = 100,
  offset    = 0,
} = {}) {
  let query = _sb
    .from("products")
    .select("*")
    .order("created_at", { ascending: false })
    .range(offset, offset + limit - 1);

  if (category  !== null) query = query.eq("category",  category);
  if (condition !== null) query = query.eq("condition", condition);
  if (is_active !== null) query = query.eq("is_active", is_active);
  if (search?.trim())     query = query.ilike("title",  `%${search.trim()}%`);

  const { data, error } = await query;
  if (error) throw new Error("Failed to fetch products: " + error.message);
  return data || [];
}


// ============================================================
//  GET PRODUCT BY ID
// ============================================================
export async function getProductById(productId) {
  if (!productId) throw new Error("Product ID is required.");

  const { data, error } = await _sb
    .from("products")
    .select("*")
    .eq("id", productId)
    .single();

  if (error) throw new Error("Product not found.");
  return data;
}


// ============================================================
//  GET PRODUCT STATS — for admin dashboard
//  Returns summary numbers in one call.
// ============================================================
export async function getProductStats() {
  const { data, error } = await _sb
    .from("products")
    .select("id, price, is_active, stock, category");

  if (error) throw new Error("Failed to fetch product stats: " + error.message);

  const total      = data.length;
  const active     = data.filter(p => p.is_active).length;
  const inactive   = total - active;
  const lowStock   = data.filter(p => p.stock !== null && p.stock > 0 && p.stock <= 3).length;
  const outOfStock = data.filter(p => p.stock !== null && p.stock === 0).length;
  const totalValue = data.reduce((sum, p) => sum + (parseFloat(p.price) || 0), 0);

  // Count by category
  const byCategory = {};
  data.forEach(p => {
    byCategory[p.category] = (byCategory[p.category] || 0) + 1;
  });

  return { total, active, inactive, lowStock, outOfStock, totalValue, byCategory };
}


// ============================================================
//  GET LOW STOCK PRODUCTS
//  Returns products with stock at or below threshold.
// ============================================================
export async function getLowStockProducts(threshold = 3) {
  const { data, error } = await _sb
    .from("products")
    .select("*")
    .lte("stock", threshold)
    .order("stock", { ascending: true });

  if (error) throw new Error("Failed to fetch low stock products: " + error.message);
  return data || [];
}


// ============================================================
//  CATEGORY MANAGEMENT
//  Reads from Supabase `categories` table if it exists,
//  otherwise falls back to the hardcoded CATEGORIES list above.
// ============================================================
export async function getCustomCategories() {
  const { data, error } = await _sb
    .from("categories")
    .select("*")
    .order("name", { ascending: true });

  if (error || !data?.length) return CATEGORIES; // fallback
  return data;
}

export async function addCategory({ name, icon = "📦" }) {
  if (!name?.trim()) throw new Error("Category name is required.");
  await requireAdminSession();

  const { data, error } = await _sb
    .from("categories")
    .insert([{ name: name.trim(), icon }])
    .select()
    .single();

  if (error) throw new Error("Failed to add category: " + error.message);
  return data;
}

export async function deleteCategory(categoryId) {
  if (!categoryId) throw new Error("Category ID is required.");
  await requireAdminSession();

  const { error } = await _sb
    .from("categories")
    .delete()
    .eq("id", categoryId);

  if (error) throw new Error("Failed to delete category: " + error.message);
  return { success: true };
}


// ============================================================
//  HELPERS
// ============================================================

// Format a number as Nigerian Naira — ₦1,500,000
export function formatPrice(amount) {
  if (!amount && amount !== 0) return "₦0";
  return "₦" + Number(amount).toLocaleString("en-NG");
}

// Safely get the first image URL from a product object
export function getProductImage(product, fallback = "https://placehold.co/400x400/f4f3f0/a09890?text=No+Image") {
  if (!product) return fallback;
  if (Array.isArray(product.images) && product.images.length > 0) return product.images[0];
  if (product.image) return product.image;
  return fallback;
}

// Condition badge color helper
export function conditionColor(condition) {
  const map = {
    "New":       { bg: "#f0fdf4", color: "#16a34a" },
    "Like New":  { bg: "#eff6ff", color: "#1d4ed8" },
    "Excellent": { bg: "#eff6ff", color: "#1d4ed8" },
    "Good":      { bg: "#fef3c7", color: "#b45309" },
    "Fair":      { bg: "#fff7ed", color: "#c2410c" },
    "Used":      { bg: "#f3f4f6", color: "#6b7280" },
  };
  return map[condition] || { bg: "#f3f4f6", color: "#6b7280" };
}


// ============================================================
//  DEFAULT EXPORT — everything in one object
// ============================================================
export default {
  // CRUD
  addProduct,
  editProduct,
  deleteProduct,
  toggleProductStatus,

  // Fetch
  getProducts,
  getProductById,
  getProductStats,
  getLowStockProducts,

  // Images
  uploadProductImage,
  uploadProductImages,

  // Categories
  getCustomCategories,
  addCategory,
  deleteCategory,

  // Constants
  CATEGORIES,
  CATEGORY_NAMES,
  CONDITIONS,
  CONDITION_NAMES,

  // Helpers
  formatPrice,
  getProductImage,
  conditionColor,
};
