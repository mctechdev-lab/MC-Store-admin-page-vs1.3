// ============================================================
//  admin-auth.js — MC Store Admin Authentication
//  Uses server-side password check via /api/admin-auth
//  Password lives ONLY in Vercel env vars — never in browser
// ============================================================

const LOGIN_PAGE  = 'index.html';
const SESSION_KEY = 'mc_admin_tok';
const SESSION_TTL = 8 * 60 * 60 * 1000; // 8 hours

// ── Save session ──
function _saveSession(token, email) {
  const s = { token, email: email || 'admin', savedAt: Date.now() };
  localStorage.setItem(SESSION_KEY, JSON.stringify(s));
  return s;
}

// ── Get stored session ──
function _getSession() {
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

// ── Verify token with server ──
async function _verifyToken(token) {
  try {
    const r = await fetch('/api/admin-auth', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'verify', token })
    });
    const d = await r.json();
    return d.ok === true;
  } catch { return false; }
}

// ============================================================
//  ADMIN LOGIN
// ============================================================
async function adminLogin({ password }) {
  if (!password) return { success: false, error: 'Please enter your password.' };
  try {
    const r = await fetch('/api/admin-auth', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password })
    });
    const d = await r.json();
    if (d.ok) {
      _saveSession(d.token, 'admin@mcstore.ng');
      return { success: true };
    }
    return { success: false, error: d.error || 'Wrong password. Please try again.' };
  } catch (e) {
    return { success: false, error: 'Network error. Check your connection.' };
  }
}

// ============================================================
//  VERIFY ADMIN — call on every protected page
// ============================================================
async function verifyAdmin() {
  const s = _getSession();
  if (!s) { _redirectToLogin('Please sign in.'); return null; }

  // Refresh TTL
  s.savedAt = Date.now();
  localStorage.setItem(SESSION_KEY, JSON.stringify(s));
  return s;
}

// ============================================================
//  GET USER / SESSION
// ============================================================
function getAdminUser() { return _getSession(); }
async function getAdminSession() { return _getSession(); }
function isAdminLoggedIn() { return !!_getSession(); }

// ============================================================
//  LOGOUT
// ============================================================
async function adminLogout() {
  localStorage.removeItem(SESSION_KEY);
  window.location.href = LOGIN_PAGE;
}

// ============================================================
//  SESSION KEEP-ALIVE
// ============================================================
function startSessionRefresh() {
  setInterval(() => {
    const s = _getSession();
    if (!s) { _redirectToLogin('Session expired.'); return; }
    s.savedAt = Date.now();
    localStorage.setItem(SESSION_KEY, JSON.stringify(s));
  }, 15 * 60 * 1000);
}

// ── Redirect helper ──
function _redirectToLogin(msg) {
  if (msg) sessionStorage.setItem('adminLoginMsg', msg);
  const path = window.location.pathname;
  if (!path.endsWith('index.html') && !path.endsWith('/')) {
    window.location.href = LOGIN_PAGE;
  }
}

// ── Audit log (Supabase) ──
const SB_URL = 'https://kswikkoqfpyxuurzxail.supabase.co';
const SB_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Imtzd2lra29xZnB5eHV1cnp4YWlsIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzEzNjEzMDQsImV4cCI6MjA4NjkzNzMwNH0.uuoSKWOTeXot1HJys0EO9OcIRBL0mKrNHIUHIAPCpZ4';

async function _logAction(action, detail) {
  try {
    await fetch(`${SB_URL}/rest/v1/admin_audit_log`, {
      method: 'POST',
      headers: { apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}`, 'Content-Type': 'application/json', Prefer: 'return=minimal' },
      body: JSON.stringify({ admin_uid: 'owner', admin_email: 'admin@mcstore.ng', action, detail: String(detail).slice(0, 500), created_at: new Date().toISOString() })
    });
  } catch {}
}

window.adminLogAction = _logAction;

// ── Global export ──
window.adminAuth = {
  adminLogin,
  adminLogout,
  verifyAdmin,
  getAdminSession,
  getAdminUser,
  isAdminLoggedIn,
  startSessionRefresh,
};
