// /api/userinfo.js
// ============================================================
//  Merges: Firebase Auth + Firebase Firestore + Supabase
//  Called by admin user-management.html
// ============================================================

import admin from "firebase-admin";

// ── Firebase Admin — safe init ──
try {
  if (!admin.apps.length) {
    const serviceAccount = JSON.parse(process.env.FIREBASE_ADMIN_KEY);
    admin.initializeApp({
      credential:  admin.credential.cert(serviceAccount),
      databaseURL: "https://mc-store-b6beb.firebaseio.com"
    });
  }
} catch(initErr) {
  console.error("Firebase init error:", initErr.message);
}

// ── Safe Firestore timestamp → ISO string ──
function toISO(val) {
  if (!val) return null;
  // Firestore Timestamp object
  if (val && typeof val.toDate === "function") return val.toDate().toISOString();
  // Plain seconds object from Admin SDK
  if (val && val._seconds) return new Date(val._seconds * 1000).toISOString();
  // Already a string
  if (typeof val === "string") return val;
  return null;
}

// ── Supabase — get spend/block stats ──
const SB_URL  = "https://kswikkoqfpyxuurzxail.supabase.co";
const SB_ANON = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Imtzd2lra29xZnB5eHV1cnp4YWlsIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzEzNjEzMDQsImV4cCI6MjA4NjkzNzMwNH0.uuoSKWOTeXot1HJys0EO9OcIRBL0mKrNHIUHIAPCpZ4";

async function getSupabaseMap() {
  try {
    const r = await fetch(
      `${SB_URL}/rest/v1/customers?select=uid,total_orders,total_spent,is_blocked&limit=2000`,
      { headers: { apikey: SB_ANON, Authorization: `Bearer ${SB_ANON}` } }
    );
    if (!r.ok) return {};
    const rows = await r.json();
    const map  = {};
    (rows || []).forEach(row => { if (row.uid) map[row.uid] = row; });
    return map;
  } catch (e) {
    console.warn("Supabase fetch failed (non-critical):", e.message);
    return {};
  }
}

// ── Main handler ──
export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin",  "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "GET")    return res.status(405).json({ success: false, error: "Method not allowed" });

  try {
    // ── 1. Firebase Auth — list all users ──
    let authResult;
    try {
      authResult = await admin.auth().listUsers(1000);
    } catch (authErr) {
      console.error("Firebase Auth listUsers failed:", authErr);
      return res.status(500).json({
        success: false,
        error:   `Firebase Auth error: ${authErr.message}. Check FIREBASE_ADMIN_KEY env var.`
      });
    }

    const authUsers = authResult.users || [];
    if (!authUsers.length) {
      return res.status(200).json({ success: true, users: [], meta: { total: 0 } });
    }

    // ── 2. Firestore — batch fetch customer docs ──
    //  Use getAll() which is a single RPC — much more reliable than
    //  Promise.all(100 x doc.get())
    const db       = admin.firestore();
    const docRefs  = authUsers.map(u => db.collection("customers").doc(u.uid));
    const firestoreMap = {};

    try {
      // getAll accepts up to 500 refs at once
      const CHUNK = 500;
      for (let i = 0; i < docRefs.length; i += CHUNK) {
        const chunk = docRefs.slice(i, i + CHUNK);
        const snaps = await db.getAll(...chunk);
        snaps.forEach(snap => {
          if (snap.exists) firestoreMap[snap.id] = snap.data();
        });
      }
    } catch (fsErr) {
      // Firestore failing is non-critical — we still show Auth users
      console.warn("Firestore batch fetch failed (non-critical):", fsErr.message);
    }

    // ── 3. Supabase — spend / block stats ──
    const sbMap = await getSupabaseMap();

    // ── 4. Merge all three ──
    const users = authUsers.map(au => {
      const fs = firestoreMap[au.uid] || {};
      const sb = sbMap[au.uid]        || {};

      // Determine provider
      const provider = fs.provider
        || (au.providerData?.[0]?.providerId === "google.com" ? "google" : "email");

      return {
        uid:          au.uid,
        fullName:     fs.fullName     || au.displayName || (au.email||"").split("@")[0] || "Unknown",
        email:        au.email        || fs.email        || null,
        phone:        fs.phone        || au.phoneNumber  || null,
        address:      fs.address      || null,
        photo_url:    fs.photoURL     || au.photoURL     || null,
        provider,
        // Timestamps — safely converted
        createdAt:    toISO(fs.createdAt)  || au.metadata?.creationTime  || null,
        lastLogin:    toISO(fs.lastLogin)  || au.metadata?.lastSignInTime || null,
        // Supabase stats
        total_orders: Number(sb.total_orders || 0),
        total_spent:  Number(sb.total_spent  || 0),
        is_blocked:   sb.is_blocked === true
      };
    });

    // Sort newest first
    users.sort((a, b) => new Date(b.createdAt || 0) - new Date(a.createdAt || 0));

    return res.status(200).json({
      success: true,
      users,
      meta: {
        total:        users.length,
        fromFirestore: Object.keys(firestoreMap).length,
        fromSupabase:  Object.keys(sbMap).length
      }
    });

  } catch (err) {
    console.error("userinfo unhandled error:", err);
    return res.status(500).json({ success: false, error: err.message });
  }
}
