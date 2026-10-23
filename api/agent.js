// /api/agent.js  (Vercel serverless, Node, no dependencies)
//
// Env vars (Vercel > Settings > Environment Variables):
//   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
//   FIREBASE_API_KEY        (web API key of your Firebase project)
//   ADMIN_EMAILS            (comma-separated admin emails)
//   AGENT_INTERNAL_SECRET   (long random string; agents/server code only)
//
// GET  /api/agent?status=pending      admin: list actions
// POST {op:'propose', ...}            internal: an agent proposes an action
// POST {op:'complete', id, result}    internal: agent reports result of an 'auto' action
// POST {op:'decide', id, decision}    admin: approve | reject

const crypto = require('crypto');
const { PRODUCTS } = require('../lib/config');

const RISK = { low: 1, medium: 2, high: 3 };
const STATUSES = ['pending', 'approved', 'rejected', 'auto', 'executed', 'failed'];
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Code that runs after an admin approves. Key: `${task_type}`.
// Phase 1 adds handlers here, e.g. product_publish.
const HANDLERS = {
  product_publish: async (action) => {
    const edited = action.edited_action || action.proposed_action || {};
    const id = edited.product_id;
    if (!id) throw new Error('No product_id on action');
    // Apply any admin edits to the listing fields, then publish
    const fields = edited.listing_changes && typeof edited.listing_changes === 'object' ? edited.listing_changes : {};
    await sb(`/${PRODUCTS.table}?${PRODUCTS.idCol}=eq.${encodeURIComponent(id)}`, {
      method: 'PATCH', body: JSON.stringify({ ...fields, [PRODUCTS.statusCol]: PRODUCTS.activeValue }),
    });
    return { published: true, product_id: id };
  },
};

async function sb(path, opts = {}) {
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const r = await fetch(process.env.SUPABASE_URL + '/rest/v1' + path, {
    ...opts,
    headers: {
      apikey: key,
      Authorization: 'Bearer ' + key,
      'Content-Type': 'application/json',
      Prefer: 'return=representation',
      ...(opts.headers || {}),
    },
  });
  const text = await r.text();
  if (!r.ok) throw new Error(`Supabase ${r.status}: ${text}`);
  return text ? JSON.parse(text) : [];
}

const audit = (action_id, event, actor, details = {}) =>
  sb('/agent_audit_log', { method: 'POST', body: JSON.stringify({ action_id, event, actor, details }) });

function isInternal(req) {
  const given = Buffer.from(String(req.headers['x-agent-secret'] || ''));
  const real = Buffer.from(process.env.AGENT_INTERNAL_SECRET || '');
  return real.length > 0 && given.length === real.length && crypto.timingSafeEqual(given, real);
}

// Verifies the Firebase ID token and checks the email against ADMIN_EMAILS
async function adminEmail(req) {
  const token = (req.headers.authorization || '').replace(/^Bearer /, '');
  if (!token) return null;
  const r = await fetch(
    'https://identitytoolkit.googleapis.com/v1/accounts:lookup?key=' + process.env.FIREBASE_API_KEY,
    { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ idToken: token }) }
  );
  if (!r.ok) return null;
  const email = ((await r.json()).users || [])[0]?.email?.toLowerCase();
  const allowed = (process.env.ADMIN_EMAILS || '').toLowerCase().split(',').map((s) => s.trim());
  return email && allowed.includes(email) ? email : null;
}

async function propose(body, res) {
  const { agent, task_type, subject_type, subject_id, input, proposed_action, reason, expected_result, sources } = body;
  const risk = body.risk_level || 'low';
  if (!agent || !task_type || !RISK[risk]) return res.status(400).json({ error: 'agent, task_type and a valid risk_level are required' });

  const perm = (await sb(`/agent_permissions?task_type=eq.${encodeURIComponent(task_type)}&select=mode,max_risk`))[0];
  let mode = perm ? perm.mode : 'approval'; // unknown task types always need approval
  if (perm && RISK[risk] > RISK[perm.max_risk] && mode === 'auto') mode = 'approval';
  const status = mode === 'never' ? 'rejected' : mode === 'auto' ? 'auto' : 'pending';

  const [row] = await sb('/agent_actions', {
    method: 'POST',
    body: JSON.stringify({
      agent, task_type, subject_type, subject_id: subject_id != null ? String(subject_id) : null,
      input: input || {}, proposed_action: proposed_action || {}, reason, expected_result, sources: sources || [],
      risk_level: risk, status,
      review_note: mode === 'never' ? 'Blocked by permission rules' : null,
    }),
  });
  await audit(row.id, 'proposed', agent, { task_type, risk, resulting_status: status });
  return res.status(200).json({ id: row.id, status });
}

async function complete(body, res) {
  const { id, result, error } = body;
  if (!UUID.test(id || '')) return res.status(400).json({ error: 'Invalid id' });
  const status = error ? 'failed' : 'executed';
  const rows = await sb(`/agent_actions?id=eq.${id}&status=in.(auto,approved)`, {
    method: 'PATCH', body: JSON.stringify({ status, result: result || null, error: error || null }),
  });
  if (!rows.length) return res.status(409).json({ error: 'Action is not in a completable state' });
  await audit(id, status, rows[0].agent, { error: error || null });
  return res.status(200).json({ id, status });
}

async function decide(body, email, res) {
  const { id, decision, note, edited_action } = body;
  if (!UUID.test(id || '') || !['approve', 'reject'].includes(decision)) return res.status(400).json({ error: 'id and decision (approve|reject) required' });
  if (edited_action != null && (typeof edited_action !== 'object' || Array.isArray(edited_action))) return res.status(400).json({ error: 'edited_action must be an object' });

  // Only a still-pending action can be decided, so double-clicks can't double-approve
  const rows = await sb(`/agent_actions?id=eq.${id}&status=eq.pending`, {
    method: 'PATCH',
    body: JSON.stringify({
      status: decision === 'approve' ? 'approved' : 'rejected',
      reviewed_by: email, reviewed_at: new Date().toISOString(), review_note: note || null,
      edited_action: decision === 'approve' && edited_action ? edited_action : null,
    }),
  });
  if (!rows.length) return res.status(409).json({ error: 'Already decided or not found' });
  const action = rows[0];
  await audit(id, action.status, email, { note: note || null, edited: !!action.edited_action });

  const handler = decision === 'approve' && HANDLERS[action.task_type];
  if (handler) {
    try {
      const result = await handler(action);
      await sb(`/agent_actions?id=eq.${id}`, { method: 'PATCH', body: JSON.stringify({ status: 'executed', result }) });
      await audit(id, 'executed', action.agent);
      return res.status(200).json({ id, status: 'executed' });
    } catch (e) {
      await sb(`/agent_actions?id=eq.${id}`, { method: 'PATCH', body: JSON.stringify({ status: 'failed', error: String(e.message).slice(0, 500) }) });
      await audit(id, 'failed', action.agent, { error: String(e.message).slice(0, 500) });
      return res.status(200).json({ id, status: 'failed' });
    }
  }
  return res.status(200).json({ id, status: action.status });
}

module.exports = async (req, res) => {
  try {
    if (req.method === 'GET') {
      if (!(await adminEmail(req))) return res.status(401).json({ error: 'Admin only' });
      const status = STATUSES.includes(req.query.status) ? req.query.status : 'pending';
      const rows = await sb(`/agent_actions?status=eq.${status}&order=created_at.desc&limit=50`);
      return res.status(200).json({ actions: rows });
    }
    if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

    const body = req.body || {};
    if (body.op === 'propose' || body.op === 'complete') {
      if (!isInternal(req)) return res.status(401).json({ error: 'Internal only' });
      return body.op === 'propose' ? propose(body, res) : complete(body, res);
    }
    if (body.op === 'decide') {
      const email = await adminEmail(req);
      if (!email) return res.status(401).json({ error: 'Admin only' });
      return decide(body, email, res);
    }
    return res.status(400).json({ error: 'Unknown op' });
  } catch (e) {
    console.error('agent api error:', e);
    return res.status(500).json({ error: 'Server error' });
  }
};
