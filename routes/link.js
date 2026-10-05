// ══════════════════════════════════════════════════════════════
//  /api/link — Compass's server-to-server link to this app
//
//  POST /api/link/evidence   (service token)  body: { client, focus:[...] }
//    Returns the accreditation evidence the inspector has sent for that
//    client from any project, and stores what Compass says the client still
//    needs (the focus areas for the next visit). Auth is the shared secret
//    in LINK_SERVICE_TOKEN (set in Coolify, never committed, never sent to a
//    browser), compared in constant time - the same scheme the Workplace
//    Inspection app serves Compass with.
//
//  GET /api/link/focus?client=  (signed-in inspector)
//    What Compass last asked for, for the visit details and the Compass panel.
//
//  The evidence lives inside each project's own saved state, under
//  AHS_ACCRED_EVIDENCE_V1, so it syncs, backs up and restores with the
//  inspection it came from. Nothing here writes to a project.
// ══════════════════════════════════════════════════════════════
const express = require('express');
const crypto  = require('crypto');
const { pool } = require('../db');
const { requireAuth } = require('../middleware/auth');

const EVIDENCE_KEY = 'AHS_ACCRED_EVIDENCE_V1';
const router = express.Router();

function checkToken(req){
  const configured = process.env.LINK_SERVICE_TOKEN || '';
  if(configured.length < 32) return { ok: false, code: 503, error: 'link_not_configured' };
  const m = String(req.headers.authorization || '').match(/^Bearer\s+(.+)$/i);
  if(!m) return { ok: false, code: 401, error: 'missing_token' };
  const given = Buffer.from(m[1], 'utf8');
  const want  = Buffer.from(configured, 'utf8');
  if(given.length !== want.length || !crypto.timingSafeEqual(given, want)){
    return { ok: false, code: 401, error: 'bad_token' };
  }
  return { ok: true };
}

// "MVL", " mvl " and "Mvl" are the same client reference.
function normRef(s){ return String(s || '').trim().toLowerCase().replace(/\s+/g, ' '); }

// rows: [{ project, ev }] where ev is the stored value (a JSON string, as
// localStorage keeps it). Pure, so the matching can be tested without a DB.
function evidenceFor(rows, client){
  const want = normRef(client);
  if(!want) return [];
  const out = [];
  (rows || []).forEach(r => {
    let v = r && r.ev;
    if(typeof v === 'string'){ try{ v = JSON.parse(v); }catch(e){ return; } }
    if(!v || typeof v !== 'object' || normRef(v.client) !== want) return;
    (Array.isArray(v.sent) ? v.sent : []).forEach(rec => {
      if(!rec || typeof rec !== 'object') return;
      out.push({
        inspectionId: String(rec.inspectionId || ''), project: String(rec.project || r.project || ''),
        visit: rec.visit || '', date: String(rec.date || ''), sentAt: String(rec.sentAt || ''),
        inspector: String(rec.inspector || ''), reportName: String(rec.reportName || ''),
        items: (Array.isArray(rec.items) ? rec.items : []).map(it => ({
          qids: (Array.isArray(it && it.qids) ? it.qids : []).map(String).filter(q => /^[A-Z]{2}-\d{2}$/.test(q)),
          checkId: String(it && it.checkId || ''), check: String(it && it.check || ''), note: String(it && it.note || ''),
          photo: /^data:image\/(jpeg|png);base64,/.test(String(it && it.photo || '')) ? String(it.photo) : '',
        })).filter(it => it.qids.length),
      });
    });
  });
  return out.sort((a, b) => String(b.date).localeCompare(String(a.date)));
}

function cleanFocus(list){
  return (Array.isArray(list) ? list : []).slice(0, 120).map(f => ({
    id: String(f && f.id || '').slice(0, 12), area: String(f && f.area || '').slice(0, 60),
    text: String(f && f.text || '').slice(0, 400), status: String(f && f.status || '').slice(0, 40),
    site: String(f && f.site || '').slice(0, 200),
  })).filter(f => /^[A-Z]{2}-\d{2}$/.test(f.id));
}

router.post('/evidence', async (req, res) => {
  const t = checkToken(req);
  if(!t.ok) return res.status(t.code).json({ error: t.error });
  const client = normRef(req.body && req.body.client);
  if(!client) return res.status(400).json({ error: 'client_required' });
  try {
    if(Array.isArray(req.body.focus)){
      await pool.query(
        `INSERT INTO link_focus (client, focus, updated_at) VALUES ($1, $2::jsonb, NOW())
         ON CONFLICT (client) DO UPDATE SET focus = EXCLUDED.focus, updated_at = NOW()`,
        [client, JSON.stringify(cleanFocus(req.body.focus))]
      );
    }
    // Only the one key is read from each project, never its photos.
    const r = await pool.query(`SELECT project, state->>'${EVIDENCE_KEY}' AS ev FROM app_state WHERE state ? '${EVIDENCE_KEY}'`);
    res.json({ client, records: evidenceFor(r.rows, client) });
  } catch(err){
    console.error('POST /api/link/evidence error:', err);
    res.status(500).json({ error: 'server_error' });
  }
});

router.get('/focus', requireAuth, async (req, res) => {
  const client = normRef(req.query && req.query.client);
  if(!client) return res.json({ client: '', focus: [], updatedAt: null });
  try {
    const r = await pool.query(`SELECT focus, updated_at FROM link_focus WHERE client = $1 LIMIT 1`, [client]);
    res.json({ client, focus: r.rows.length ? (r.rows[0].focus || []) : [], updatedAt: r.rows.length ? r.rows[0].updated_at : null });
  } catch(err){
    console.error('GET /api/link/focus error:', err);
    res.status(500).json({ error: 'server_error' });
  }
});

module.exports = router;
module.exports.evidenceFor = evidenceFor;
module.exports.normRef = normRef;
module.exports.cleanFocus = cleanFocus;
module.exports.EVIDENCE_KEY = EVIDENCE_KEY;
