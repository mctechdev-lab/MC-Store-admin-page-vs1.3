// ============================================================
//  admin-auth.js — MC Store Admin (browser side)
//
//  The browser holds NO secret. Sign-in happens on the server (/api/admin-auth),
//  which sets an HttpOnly cookie that scripts cannot read. The small
//  "mc_admin_info" value kept here (email + role) is only a hint for showing
//  the right screen — every API call is checked again by the server.
// ============================================================

const LOGIN_PAGE = 'index.html';
const INFO_KEY   = 'mc_admin_info';

function _info() {
  try { return JSON.parse(localStorage.getItem(INFO_KEY) || 'null'); } catch { return null; }
}
function _setInfo(i) { try { localStorage.setItem(INFO_KEY, JSON.stringify(i)); } catch {} }
function _clearInfo() { try { localStorage.removeItem(INFO_KEY); } catch {} }

async function _post(body) {
  const r = await fetch('/api/admin-auth', {
    method: 'POST', credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });
  let d = {}; try { d = await r.json(); } catch {}
  return { status: r.status, data: d };
}

function _redirectToLogin(msg) {
  _clearInfo();
  if (msg) { try { sessionStorage.setItem('adminLoginMsg', msg); } catch {} }
  const path = window.location.pathname;
  if (!path.endsWith('index.html') && !path.endsWith('/')) window.location.href = LOGIN_PAGE;
}

// ── Login ──
async function adminLogin({ email, password }) {
  if (!email || !password) return { success: false, error: 'Please enter your email and password.' };
  try {
    const { data } = await _post({ action: 'login', email, password });
    if (data.ok) { _setInfo({ email: data.email, role: data.role }); return { success: true, role: data.role }; }
    return { success: false, error: data.error || 'Wrong email or password. Please try again.' };
  } catch (e) {
    return { success: false, error: 'Network error. Check your connection.' };
  }
}

// ── Ask the server whether we are signed in (call on every protected page) ──
async function verifyAdmin() {
  try {
    const { status, data } = await _post({ action: 'me' });
    if (status === 200 && data.ok) { const i = { email: data.email, role: data.role }; _setInfo(i); return i; }
  } catch (e) { return _info(); }       // offline: keep showing the page; the server still blocks every action
  _redirectToLogin('Please sign in.');
  return null;
}

function getAdminUser()       { return _info(); }
async function getAdminSession() { return _info(); }
function isAdminLoggedIn()    { return !!_info(); }

async function adminLogout() {
  try { await _post({ action: 'logout' }); } catch {}
  _clearInfo();
  window.location.href = LOGIN_PAGE;
}

// re-check with the server every 10 minutes
function startSessionRefresh() {
  setInterval(() => { verifyAdmin(); }, 10 * 60 * 1000);
}

// Audit entries are written by the SERVER (the old browser-side write could be forged)
async function _logAction(action, detail) {
  try {
    await _post({ action: 'audit', event: String(action).toLowerCase().replace(/[^a-z0-9_]/g, '_').slice(0, 60), detail: String(detail || '').slice(0, 400) });
  } catch {}
}
window.adminLogAction = _logAction;

window.adminAuth = {
  adminLogin, adminLogout, verifyAdmin, getAdminSession, getAdminUser, isAdminLoggedIn, startSessionRefresh,
};

// Every page that loads this file (except the login page) confirms with the server on load.
(function () {
  const p = window.location.pathname;
  if (!p.endsWith('index.html') && !p.endsWith('/')) verifyAdmin();
})();
