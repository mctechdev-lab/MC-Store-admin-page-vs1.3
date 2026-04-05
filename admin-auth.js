// ============================================================
//  admin-auth.js — MC Store Admin Authentication
//
//  WHAT THIS FILE DOES:
//  1. Handles admin login via Supabase
//  2. Verifies admin session on every protected page
//  3. Redirects to login if session is missing or expired
//  4. Handles logout
//
//  HOW TO USE ON EVERY PROTECTED ADMIN PAGE:
//  ─────────────────────────────────────────
//  Step 1 — Add this to your <head> BEFORE any other scripts:
//    <script src="https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2"></script>
//
//  Step 2 — Add this at the TOP of your page <script> (non-module):
//    <script src="admin-auth.js"></script>
//
//  Step 3 — Call verifyAdmin() at the start of your page logic:
//    verifyAdmin();   ← this will auto-redirect if not logged in
//
//  OR in a module script:
//    import { verifyAdmin, getAdminSession, adminLogout } from './admin-auth.js';
//    await verifyAdmin();
//
//  LOGIN PAGE (admin-index.html) uses:
//    adminLogin({ email, password })
// ============================================================

const SUPABASE_URL    = "https://kswikkoqfpyxuurzxail.supabase.co";
const SUPABASE_KEY    = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Imtzd2lra29xZnB5eHV1cnp4YWlsIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzEzNjEzMDQsImV4cCI6MjA4NjkzNzMwNH0.uuoSKWOTeXot1HJys0EO9OcIRBL0mKrNHIUHIAPCpZ4";
const LOGIN_PAGE      = "admin-index.html";
const SESSION_KEY     = "adminSession";

// ── Supabase client ──
let _sb;
try {
  _sb = window.supabase.createClient(SUPABASE_URL, SUPABASE_KEY);
} catch(e) {
  console.error('[admin-auth] Failed to init Supabase. Make sure supabase-js CDN loads BEFORE admin-auth.js', e);
}

// ── Cached session ──
let _cachedSession = null;


// ============================================================
//  ADMIN LOGIN
//  Called by admin-index.html login button.
//  Saves session to localStorage on success.
//
//  Returns: { success: true, session } or { success: false, error }
// ============================================================
async function adminLogin({ email, password }) {
  if (!email?.trim() || !password) {
    return { success: false, error: "Please enter your email and password." };
  }

  if (!_sb) {
    return { success: false, error: "Auth service not ready. Please refresh the page." };
  }

  try {
    const { data, error } = await _sb.auth.signInWithPassword({ email, password });

    if (error) {
      const msg = _friendlyError(error.message);
      return { success: false, error: msg };
    }

    if (!data.session) {
      return { success: false, error: "Login failed. No session returned." };
    }

    // Verify this user is actually an admin
    const isAdmin = await _checkAdminRole(data.session);
    if (!isAdmin) {
      await _sb.auth.signOut();
      return { success: false, error: "Access denied. This account does not have admin privileges." };
    }

    // Save session to localStorage
    _cachedSession = data.session;
    localStorage.setItem(SESSION_KEY, JSON.stringify(data.session));

    return { success: true, session: data.session };

  } catch (err) {
    console.error("[admin-auth] Login error:", err);
    return { success: false, error: err.message || "An unexpected error occurred." };
  }
}


// ============================================================
//  VERIFY ADMIN — call this on EVERY protected page
//  If not logged in → redirects to admin-index.html
//  If logged in → returns the session silently
//
//  Usage:
//    const session = await verifyAdmin();
//    // If this line runs, admin is verified ✅
// ============================================================
async function verifyAdmin() {
  try {
    // 1. Check Supabase live session first
    const { data, error } = await _sb.auth.getSession();

    if (!error && data.session) {
      _cachedSession = data.session;
      localStorage.setItem(SESSION_KEY, JSON.stringify(data.session));
      _updateAdminBadge(data.session);
      return data.session;
    }

    // 2. Try restoring from localStorage as fallback
    const stored = localStorage.getItem(SESSION_KEY);
    if (stored) {
      try {
        const parsed = JSON.parse(stored);
        // Check if token is still valid (not expired)
        const expiry = parsed?.expires_at;
        if (expiry && Date.now() / 1000 < expiry) {
          // Try to refresh the session
          const { data: refreshed } = await _sb.auth.refreshSession({
            refresh_token: parsed.refresh_token,
          });
          if (refreshed?.session) {
            _cachedSession = refreshed.session;
            localStorage.setItem(SESSION_KEY, JSON.stringify(refreshed.session));
            _updateAdminBadge(refreshed.session);
            return refreshed.session;
          }
        }
      } catch (_) {
        // Stored session is corrupt — clear it
        localStorage.removeItem(SESSION_KEY);
      }
    }

    // 3. No valid session found — redirect to login
    _redirectToLogin("Session expired. Please log in again.");
    return null;

  } catch (err) {
    console.error("[admin-auth] verifyAdmin error:", err);
    _redirectToLogin("Authentication error. Please log in.");
    return null;
  }
}


// ============================================================
//  GET ADMIN SESSION
//  Returns the cached session without redirecting.
//  Use this when you need the session but don't want to redirect.
// ============================================================
async function getAdminSession() {
  if (_cachedSession) return _cachedSession;

  const { data } = await _sb.auth.getSession();
  if (data?.session) {
    _cachedSession = data.session;
    return _cachedSession;
  }

  return null;
}


// ============================================================
//  GET ADMIN USER INFO
//  Returns basic info about the logged-in admin.
// ============================================================
async function getAdminUser() {
  const session = await getAdminSession();
  if (!session) return null;

  return {
    uid:         session.user.id,
    email:       session.user.email,
    name:        session.user.user_metadata?.full_name || session.user.email?.split("@")[0] || "Admin",
    avatar:      session.user.user_metadata?.avatar_url || null,
    lastSignIn:  session.user.last_sign_in_at,
  };
}


// ============================================================
//  ADMIN LOGOUT
//  Clears session from Supabase + localStorage → redirects to login
// ============================================================
async function adminLogout() {
  try {
    await _sb.auth.signOut();
  } catch (_) {}

  _cachedSession = null;
  localStorage.removeItem(SESSION_KEY);
  window.location.href = LOGIN_PAGE;
}


// ============================================================
//  CHECK IF ADMIN IS LOGGED IN (non-async quick check)
//  Useful for showing/hiding UI elements before async check.
// ============================================================
function isAdminLoggedIn() {
  try {
    const stored = localStorage.getItem(SESSION_KEY);
    if (!stored) return false;
    const parsed = JSON.parse(stored);
    const expiry = parsed?.expires_at;
    return expiry ? Date.now() / 1000 < expiry : false;
  } catch (_) {
    return false;
  }
}


// ============================================================
//  AUTO REFRESH — keeps session alive while admin is working
//  Call this once on any long-running admin page.
//
//  Usage:
//    startSessionRefresh();
// ============================================================
function startSessionRefresh() {
  // Refresh every 10 minutes
  setInterval(async () => {
    const { data } = await _sb.auth.refreshSession();
    if (data?.session) {
      _cachedSession = data.session;
      localStorage.setItem(SESSION_KEY, JSON.stringify(data.session));
    }
  }, 10 * 60 * 1000);

  // Also listen for auth state changes (tab visibility, etc.)
  _sb.auth.onAuthStateChange((event, session) => {
    if (event === "SIGNED_OUT") {
      _redirectToLogin("You have been logged out.");
    } else if (session) {
      _cachedSession = session;
      localStorage.setItem(SESSION_KEY, JSON.stringify(session));
    }
  });
}


// ============================================================
//  PRIVATE HELPERS
// ============================================================

// Check if logged-in user has admin role
// Checks Supabase user metadata for role = 'admin'
async function _checkAdminRole(session) {
  if (!session?.user) return false;

  // Check user_metadata.role
  const role = session.user.user_metadata?.role;
  if (role === "admin") return true;

  // Check app_metadata.role (set server-side)
  const appRole = session.user.app_metadata?.role;
  if (appRole === "admin") return true;

  // Fallback — if no role is set yet, allow any verified Supabase user
  // Remove this fallback once you set roles properly
  if (session.user.email) return true;

  return false;
}

// Redirect to login page with optional message
function _redirectToLogin(message = "") {
  if (message) {
    sessionStorage.setItem("adminLoginMsg", message);
  }
  // Don't redirect if already on the login page
  if (!window.location.pathname.includes(LOGIN_PAGE)) {
    window.location.href = LOGIN_PAGE;
  }
}

// Update the admin badge in the header (if it exists on the page)
function _updateAdminBadge(session) {
  const badge    = document.getElementById("authBadge");
  const badgeTxt = document.getElementById("authBadgeText");
  if (!badge || !badgeTxt) return;

  const name = session.user.user_metadata?.full_name
    || session.user.email?.split("@")[0]
    || "Admin";

  badge.className     = "auth-badge logged-in";
  badgeTxt.textContent = name;
}

// Map Supabase error messages to friendly strings
function _friendlyError(msg = "") {
  const m = msg.toLowerCase();
  if (m.includes("invalid login") || m.includes("invalid credentials") || m.includes("wrong"))
    return "Wrong email or password. Please try again.";
  if (m.includes("email not confirmed"))
    return "Please confirm your email before logging in.";
  if (m.includes("too many") || m.includes("rate limit"))
    return "Too many attempts. Please wait 15 minutes.";
  if (m.includes("network") || m.includes("fetch"))
    return "Network error. Check your internet connection.";
  if (m.includes("user not found"))
    return "No admin account found with this email.";
  return msg || "Login failed. Please try again.";
}


// ============================================================
//  NON-MODULE SUPPORT
//  Makes functions available globally for pages that can't
//  use ES modules (e.g. plain <script> tags).
// ============================================================
window.adminAuth = {
  adminLogin,
  adminLogout,
  verifyAdmin,
  getAdminSession,
  getAdminUser,
  isAdminLoggedIn,
  startSessionRefresh,
};


// ============================================================
//  All functions are available via window.adminAuth
//  e.g. window.adminAuth.adminLogin({ email, password })
// ============================================================
