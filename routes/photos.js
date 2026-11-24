// ══════════════════════════════════════════════════════════════
//  /api/photos - report photos, sent and fetched one at a time
//
//  POST /have      body { ids:[...] }        which of these the server holds
//  PUT  /:id       body { data, project }    store one photo (adding only)
//  GET  /:id                                 fetch one photo
//
//  One request per photo, so a weak site signal costs at most the photo in
//  hand and the rest carry on from where they stopped. Sending the same photo
//  twice is harmless: an id always means the same picture. There is no route
//  that deletes a photo; they go only with their project (routes/store.js).
// ══════════════════════════════════════════════════════════════
const express = require('express');
const { pool } = require('../db');
const { requireAuth } = require('../middleware/auth');
const { resolveTenant, resolveProject } = require('./resolve');
const { validPhoto } = require('./photo-store');
const store = require('./store');

const router = express.Router();

router.post('/have', requireAuth, async (req, res) => {
  const tenantId = resolveTenant(req);
  if(!tenantId) return res.status(400).json({ error: 'tenant_required' });
  const ids = (Array.isArray(req.body && req.body.ids) ? req.body.ids : []).map(String).slice(0, 5000);
  try {
    res.json({ have: await store.havePhotos(pool, tenantId, ids) });
  } catch(err){
    console.error('POST /api/photos/have error:', err);
    res.status(500).json({ error: 'server_error' });
  }
});

router.put('/:id', requireAuth, express.json({ limit: '50mb' }), async (req, res) => {
  const tenantId = resolveTenant(req);
  if(!tenantId) return res.status(400).json({ error: 'tenant_required' });
  const id = String(req.params.id || ''), data = req.body && req.body.data;
  if(!validPhoto(id, data)) return res.status(400).json({ error: 'not_a_photo' });
  if(req.user.role === 'client_user' && req.user.tenantId !== tenantId) return res.status(403).json({ error: 'forbidden' });
  try {
    if(!(await store.tenantExists(pool, tenantId))) return res.status(404).json({ error: 'tenant_not_found' });
    await store.addPhotos(pool, tenantId, resolveProject(req), { [id]: data }, req.user.id);
    // Answer from what is stored, never from what was sent.
    const kept = await store.getPhoto(pool, tenantId, id);
    if(!kept) return res.status(500).json({ error: 'not_stored' });
    res.json({ ok: true, id, length: kept.length });
  } catch(err){
    console.error('PUT /api/photos error:', err);
    res.status(500).json({ error: 'server_error' });
  }
});

router.get('/:id', requireAuth, async (req, res) => {
  const tenantId = resolveTenant(req);
  if(!tenantId) return res.status(400).json({ error: 'tenant_required' });
  try {
    const data = await store.getPhoto(pool, tenantId, String(req.params.id || ''));
    if(!data) return res.status(404).json({ error: 'not_found' });
    res.setHeader('Cache-Control', 'private, no-store');
    res.json({ id: String(req.params.id), data });
  } catch(err){
    console.error('GET /api/photos error:', err);
    res.status(500).json({ error: 'server_error' });
  }
});

module.exports = router;
