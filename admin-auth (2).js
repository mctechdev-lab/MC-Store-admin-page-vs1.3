// ============================================================
//  admin-auth.js — MC Store Admin Authentication
//  FIXED: Uses Firebase Auth (not Supabase)
//  All MC Store users/admins live in Firebase — Supabase
//  does not store passwords so Supabase login never worked.
//
//  HOW TO USE ON EVERY PROTECTED PAGE:
//  1. Add Firebase SDK scripts in <head>
//  2. Add <script src="admin-auth.js"></script>
//  3. Call verifyAdmin() at start of page logic
// ============================================================

const FIREBASE_CONFIG = {
  apiKey:            "AIzaSyC7trJbzcIix4HgPEHCybb6E7Ztkc39kfw",
  authDomain:        "mc-store-b6beb.firebaseapp.com",
  projectId:         "mc-store-b6beb",
  storageBucket:     "mc-store-b6beb.firebasestorage.app",
  messagingSenderId: "930964754103",
  appId:             "1:930964754103:web:0e79c3dcd6bcc4dafc8732"
};

const LOGIN_PAGE    = "index.html";
const SESSION_KEY   = "mc_admin_session";
const SESSION_TTL   = 8 * 60 * 60 * 1000; // 8 hours

let _fireApp  = null;
let _fireAuth = null;
let _fireDb   = null;
let _cachedUser = null;

// ── Init Firebase lazily ──
async function _initFirebase() {
  if (_fireAuth) return;
  const { initializeApp, getApps } =
    await import("https://www.gstatic.com/firebasejs/10.12.0/firebase-app.js");
  const { getAuth, signInWithEmailAndPassword, signOut, onAuthStateChanged } =
    await import("https://www.gstatic.com/firebasejs/10.12.0/firebase-auth.js");
  const { getFirestore, doc, getDoc } =
    await import("https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js");

  _fireApp  = getApps().length ? getApps()[0] : initializeApp(FIREBASE_CONFIG);
  _fireAuth = getAuth(_fireApp);
  _fireDb   = getFirestore(_fireApp);

  // Store functions on window so other scripts can use them
  window._fbAuth = { signInWithEmailAndPassword, signOut, onAuthStateChanged };
  window._fbFs   = { doc, getDoc };
}

// ── Check Firestore for role:"admin" ──
async function _isAdmin(uid) {
  try {
    const snap = await window._fbFs.getDoc(
      window._fbFs.doc(_fireDb, "customers", uid)
    );
    return snap.exists() && snap.data()?.role === "admin";
  } catch { return false; }
}

// ── Save session to localStorage ──
function _saveSession(user) {
  const session = {
    uid:       user.uid,
    email:     user.email,
    name:      user.displayName || user.email.split("@")[0],
    savedAt:   Date.now()
  };
  localStorage.setItem(SESSION_KEY, JSON.stringify(session));
  _cachedUser = session;
  return session;
}

// ── Get stored session (checks TTL) ──
function _getStoredSession() {
  try {
    const raw = localStorage.getItem(SESSION_KEY);
    if (!raw) return null;
    const s = JSON.parse(raw);
    if (Date.now() - s.savedAt > SESSION_TTL) {
      localStorage.removeItem(SESSION_KEY);
      return null;
    }
    return s;
  } catch { return null; }
}

// ============================================================
//  ADMIN LOGIN — called by index.html
// ============================================================
async function adminLogin({ email, password }) {
  if (!email?.trim() || !password)
    return { success: false, error: "Please enter your email and password." };

  try {
    await _initFirebase();
    const cred = await window._fbAuth.signInWithEmailAndPassword(
      _fireAuth, email.trim(), password
    );
    const user = cred.user;

    // Check admin role in Firestore
    const ok = await _isAdmin(user.uid);
    if (!ok) {
      await window._fbAuth.signOut(_fireAuth);
      return { success: false, error: "Access denied. This account does not have admin privileges." };
    }

    _saveSession(user);
    _logAction("login", `Admin login: ${email}`);
    return { success: true };

  } catch (err) {
    return { success: false, error: _friendlyError(err.code || err.message) };
  }
}

// ============================================================
//  VERIFY ADMIN — call on every protected page
//  Redirects to login if not authenticated
// ============================================================
async function verifyAdmin() {
  // Quick check from localStorage first
  const stored = _getStoredSession();
  if (!stored) {
    _redirectToLogin("Please sign in to access the admin panel.");
    return null;
  }

  // Refresh the session timestamp so it stays alive while working
  stored.savedAt = Date.now();
  localStorage.setItem(SESSION_KEY, JSON.stringify(stored));
  _cachedUser = stored;

  // Update admin badge if present
  _updateAdminBadge(stored);
  return stored;
}

// ============================================================
//  GET ADMIN USER INFO
// ============================================================
function getAdminUser() {
  if (_cachedUser) return _cachedUser;
  return _getStoredSession();
}

async function getAdminSession() {
  return getAdminUser();
}

// ============================================================
//  LOGOUT
// ============================================================
async function adminLogout() {
  try {
    await _initFirebase();
    await window._fbAuth.signOut(_fireAuth);
  } catch {}
  _cachedUser = null;
  localStorage.removeItem(SESSION_KEY);
  window.location.href = LOGIN_PAGE;
}

// ============================================================
//  QUICK CHECK (sync)
// ============================================================
function isAdminLoggedIn() {
  return !!_getStoredSession();
}

// ============================================================
//  SESSION AUTO-REFRESH (call once on long pages)
// ============================================================
function startSessionRefresh() {
  setInterval(() => {
    const s = _getStoredSession();
    if (!s) { _redirectToLogin("Session expired."); return; }
    s.savedAt = Date.now();
    localStorage.setItem(SESSION_KEY, JSON.stringify(s));
  }, 15 * 60 * 1000); // refresh TTL every 15 min
}

// ============================================================
//  AUDIT LOG — writes to Supabase audit_log table
// ============================================================
const SB_URL = "https://kswikkoqfpyxuurzxail.supabase.co";
const SB_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Imtzd2lra29xZnB5eHV1cnp4YWlsIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzEzNjEzMDQsImV4cCI6MjA4NjkzNzMwNH0.uuoSKWOTeXot1HJys0EO9OcIRBL0mKrNHIUHIAPCpZ4";

async function _logAction(action, detail) {
  const user = _getStoredSession();
  try {
    await fetch(`${SB_URL}/rest/v1/admin_audit_log`, {
      method: "POST",
      headers: { apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}`, "Content-Type": "application/json", Prefer: "return=minimal" },
      body: JSON.stringify({
        admin_uid:   user?.uid   || "unknown",
        admin_email: user?.email || "unknown",
        action,
        detail:      String(detail).slice(0, 500),
        created_at:  new Date().toISOString()
      })
    });
  } catch {} // Never block on logging failure
}

// Expose logAction for other pages
window.adminLogAction = _logAction;

// ── PRIVATE HELPERS ──
function _redirectToLogin(msg = "") {
  if (msg) sessionStorage.setItem("adminLoginMsg", msg);
  if (!window.location.pathname.includes(LOGIN_PAGE) &&
      !window.location.href.endsWith("/")) {
    window.location.href = LOGIN_PAGE;
  }
}

function _updateAdminBadge(session) {
  const badge = document.getElementById("authBadge");
  const txt   = document.getElementById("authBadgeText");
  if (badge) badge.className = "auth-badge logged-in";
  if (txt)   txt.textContent = session?.name || "Admin";
}

function _friendlyError(code = "") {
  const c = code.toLowerCase();
  if (c.includes("wrong-password") || c.includes("invalid-credential") || c.includes("invalid-login"))
    return "Wrong email or password. Please try again.";
  if (c.includes("user-not-found"))
    return "No admin account found with this email.";
  if (c.includes("too-many-requests") || c.includes("rate-limit"))
    return "Too many failed attempts. Please wait 15 minutes.";
  if (c.includes("network"))
    return "Network error. Check your internet connection.";
  if (c.includes("disabled"))
    return "This account has been disabled. Contact support.";
  return "Login failed. Please check your details and try again.";
}

// ── Expose globally (for non-module scripts) ──
window.adminAuth = {
  adminLogin,
  adminLogout,
  verifyAdmin,
  getAdminSession,
  getAdminUser,
  isAdminLoggedIn,
  startSessionRefresh,
};
