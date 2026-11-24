// ══════════════════════════════════════════════════════════════
//  /api/state — per-(tenant, project) state load and save
//
//  Every state read/write is scoped to req.user.tenantId AND a project
//  name. A client (tenant) can keep many named projects; each is its own
//  saved register, picked/typed at login and resumed under that name.
//  Consultants without a tenant_id pick a tenant via ?tenantId=xxx.
//
//  Photos are not in here (routes/photos.js). A save from an out-of-date
//  copy is answered 409 so the app can ask which copy to use, and what a
//  save replaces is kept as an earlier version. The statements themselves
//  are in routes/store.js.
// ══════════════════════════════════════════════════════════════
const express  = require('express');
const { pool } = require('../db');
const { requireAuth } = require('../middleware/auth');
const { resolveTenant, resolveProject } = require('./resolve');
const { splitPhotos } = require('./photo-store');
const store = require('./store');

const router = express.Router();

// Run fn(client) inside one transaction.
async function atomic(fn){
  const db = await pool.connect();
  try {
    await db.query('BEGIN');
    const out = await fn(db);
    await db.query('COMMIT');
    return out;
  } catch(err){
    try { await db.query('ROLLBACK'); } catch(_){}
    throw err;
  } finally {
    db.release();
  }
}

function fail(res, where, err){
  console.error(where + ' error:', err);
  if(err && (err.code === '54000' || /size/i.test(err.message || ''))){
    return res.status(413).json({ error: 'state_too_large' });
  }
  res.status(500).json({ error: 'server_error' });
}

// GET /api/state/projects[?tenantId=xxx] — list this tenant's projects.
// Powers the "continue an existing project" picker.
router.get('/projects', requireAuth, async (req, res) => {
  const tenantId = resolveTenant(req);
  if(!tenantId){
    return res.status(400).json({ error: 'tenant_required' });
  }
  try {
    res.json({ tenantId, projects: await store.listProjects(pool, tenantId) });
  } catch(err){ fail(res, 'GET /api/state/projects', err); }
});

// GET /api/state/versions[?project=yyy] — earlier versions of a project, newest first
router.get('/versions', requireAuth, async (req, res) => {
  const tenantId = resolveTenant(req);
  if(!tenantId) return res.status(400).json({ error: 'tenant_required' });
  const project = resolveProject(req);
  try {
    res.json({ project, versions: await store.listVersions(pool, tenantId, project) });
  } catch(err){ fail(res, 'GET /api/state/versions', err); }
});

// GET /api/state/versions/:id — one earlier version (text; its photos are fetched like any others)
router.get('/versions/:id', requireAuth, async (req, res) => {
  const tenantId = resolveTenant(req);
  if(!tenantId) return res.status(400).json({ error: 'tenant_required' });
  try {
    const v = await store.getVersion(pool, tenantId, String(req.params.id));
    if(!v) return res.status(404).json({ error: 'not_found' });
    res.json(v);
  } catch(err){ fail(res, 'GET /api/state/versions/:id', err); }
});

// POST /api/state/versions  body: { state, project?, deviceName? }
// File a copy without touching the saved report: the copy someone chose not
// to use when two devices disagreed.
router.post('/versions', requireAuth, express.json({ limit: '50mb' }), async (req, res) => {
  const tenantId = resolveTenant(req);
  if(!tenantId) return res.status(400).json({ error: 'tenant_required' });
  const project = resolveProject(req);
  const given = req.body?.state;
  if(!given || typeof given !== 'object') return res.status(400).json({ error: 'state_object_required' });
  try {
    if(!(await store.tenantExists(pool, tenantId))) return res.status(404).json({ error: 'tenant_not_found' });
    const { state, photos } = splitPhotos(given);
    await store.addPhotos(pool, tenantId, project, photos, req.user.id);
    await atomic(db => store.keepCopy(db, tenantId, project, state, new Date(), String(req.body?.deviceName || '').slice(0, 60), 'not used'));
    res.json({ ok: true });
  } catch(err){ fail(res, 'POST /api/state/versions', err); }
});

// POST /api/state/rename  body: { from, to } — the report, its earlier versions and its photos
router.post('/rename', requireAuth, async (req, res) => {
  const tenantId = resolveTenant(req);
  if(!tenantId) return res.status(400).json({ error: 'tenant_required' });
  const from = String(req.body?.from || '').trim(), to = String(req.body?.to || '').trim();
  if(!from || !to || from === to) return res.status(400).json({ error: 'names_required' });
  try {
    const out = await atomic(db => store.renameProject(db, tenantId, from, to));
    if(out === 'taken')   return res.status(409).json({ error: 'name_taken' });
    if(out === 'missing') return res.status(404).json({ error: 'not_found' });
    res.json({ ok: true, project: to });
  } catch(err){ fail(res, 'POST /api/state/rename', err); }
});

// GET /api/state[?tenantId=xxx][&project=yyy][&photos=0]
// photos=0 is this build asking for the text alone. Without it the caller is
// an older build, which expects its photos inside the report.
router.get('/', requireAuth, async (req, res) => {
  const tenantId = resolveTenant(req);
  if(!tenantId){
    return res.status(400).json({ error: 'tenant_required' });
  }
  const project = resolveProject(req);
  try {
    const r = await store.loadState(pool, tenantId, project, req.query.photos !== '0');
    if(!r){
      // No state yet for this project — return empty so the frontend seeds it
      return res.json({ tenantId, project, state: null, updatedAt: null });
    }
    res.json({ tenantId, project, state: r.state, updatedAt: r.updatedAt, deviceName: r.deviceName });
  } catch(err){ fail(res, 'GET /api/state', err); }
});

// POST /api/state  body: { state: {...}, tenantId?, project?, base?, deviceId?, deviceName?, force? }
router.post('/', requireAuth, express.json({ limit: '50mb' }), async (req, res) => {
  const tenantId = resolveTenant(req);
  if(!tenantId){
    return res.status(400).json({ error: 'tenant_required' });
  }
  const project = resolveProject(req);
  const given = req.body?.state;
  if(!given || typeof given !== 'object'){
    return res.status(400).json({ error: 'state_object_required' });
  }
  try {
    // Verify the tenant exists (and the user is allowed to write to it)
    if(!(await store.tenantExists(pool, tenantId))){
      return res.status(404).json({ error: 'tenant_not_found' });
    }
    if(req.user.role === 'client_user' && req.user.tenantId !== tenantId){
      return res.status(403).json({ error: 'forbidden' });
    }
    // Photos an older build sent inside the report are added first, whatever
    // happens to the text. An empty list adds nothing and removes nothing.
    const { state, photos } = splitPhotos(given);
    await store.addPhotos(pool, tenantId, project, photos, req.user.id);

    const msg = {
      state,
      base:       req.body.base,
      force:      req.body.force === true,
      deviceId:   String(req.body.deviceId || '').slice(0, 60),
      deviceName: String(req.body.deviceName || '').slice(0, 60)
    };
    const out = await atomic(db => store.saveState(db, tenantId, project, msg, req.user.id));
    if(out.status === 'conflict'){
      return res.status(409).json({ error: 'newer_copy', updatedAt: out.updatedAt, deviceName: out.deviceName });
    }
    res.json({
      ok:        true,
      tenantId,
      project,
      updatedAt: out.updatedAt
    });
  } catch(err){ fail(res, 'POST /api/state', err); }
});

// DELETE /api/state?project=yyy — permanently remove one saved project, its
// earlier versions, and the photos no other project uses.
router.delete('/', requireAuth, async (req, res) => {
  const tenantId = resolveTenant(req);
  if(!tenantId){
    return res.status(400).json({ error: 'tenant_required' });
  }
  const project = resolveProject(req);
  if(req.user.role === 'client_user' && req.user.tenantId !== tenantId){
    return res.status(403).json({ error: 'forbidden' });
  }
  try {
    const deleted = await atomic(db => store.deleteProject(db, tenantId, project));
    res.json({ ok: true, deleted });
  } catch(err){ fail(res, 'DELETE /api/state', err); }
});

module.exports = router;
