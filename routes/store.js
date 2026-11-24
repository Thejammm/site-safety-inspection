// ══════════════════════════════════════════════════════════════
//  store - every database statement for saved reports and their photos
//
//  One place, so the routes stay thin and the same code can be run against a
//  database at start-up (selfCheck) before the server takes any traffic.
//  `db` is a pool or a client; functions that must be atomic say so and the
//  caller holds the transaction.
//
//  The rule that matters most: SAVING NEVER REMOVES A PHOTO. Photo rows go in
//  exactly one place, deleteProject, and only those no other project uses.
// ══════════════════════════════════════════════════════════════
const crypto = require('crypto');
const { decideSave, keepVersion, KEEP_MAX } = require('./merge-state');
const { PHOTO_KEY, validPhoto, splitPhotos, idsIn } = require('./photo-store');

// ── photos ────────────────────────────────────────────────────
async function recordUse(db, tenantId, project, ids){
  if(!project || !ids || !ids.length) return;
  const r = await db.query(`SELECT photo_id FROM app_photo_use WHERE tenant_id = $1 AND project = $2`, [tenantId, project]);
  const known = new Set(r.rows.map(x => x.photo_id));
  for(const id of ids){
    if(known.has(id)) continue;
    await db.query(
      `INSERT INTO app_photo_use (tenant_id, project, photo_id) VALUES ($1, $2, $3)
       ON CONFLICT (tenant_id, project, photo_id) DO NOTHING`, [tenantId, project, id]);
  }
}

// Add photos. Never replaces one, never removes one.
async function addPhotos(db, tenantId, project, photos, userId){
  const ids = Object.keys(photos || {}).filter(id => validPhoto(id, photos[id]));
  for(const id of ids){
    await db.query(
      `INSERT INTO app_photos (tenant_id, photo_id, data, created_by) VALUES ($1, $2, $3, $4)
       ON CONFLICT (tenant_id, photo_id) DO NOTHING`,
      [tenantId, id, photos[id], userId || null]
    );
  }
  await recordUse(db, tenantId, project, ids);
  return ids.length;
}

async function havePhotos(db, tenantId, ids){
  if(!ids || !ids.length) return [];
  const r = await db.query(`SELECT photo_id FROM app_photos WHERE tenant_id = $1 AND photo_id = ANY($2::text[])`, [tenantId, ids]);
  return r.rows.map(x => x.photo_id);
}

async function getPhoto(db, tenantId, id){
  const r = await db.query(`SELECT data FROM app_photos WHERE tenant_id = $1 AND photo_id = $2`, [tenantId, id]);
  return r.rows.length ? r.rows[0].data : null;
}

// ── reports ───────────────────────────────────────────────────
async function tenantExists(db, tenantId){
  const t = await db.query(`SELECT 1 AS ok FROM tenants WHERE id = $1 LIMIT 1`, [tenantId]);
  return t.rows.length > 0;
}

async function listProjects(db, tenantId){
  const r = await db.query(
    `SELECT project, updated_at FROM app_state
      WHERE tenant_id = $1 ORDER BY updated_at DESC`,
    [tenantId]
  );
  return r.rows.map(x => ({ project: x.project, updatedAt: x.updated_at }));
}

// inline = an older build is asking, and expects the photos inside the report
async function loadState(db, tenantId, project, inline){
  const r = await db.query(
    `SELECT state, updated_at, device_name FROM app_state
      WHERE tenant_id = $1 AND project = $2 LIMIT 1`,
    [tenantId, project]
  );
  if(!r.rows.length) return null;
  const row = r.rows[0];
  const split = splitPhotos(row.state);
  let state = split.state;
  if(inline){
    const photos = Object.assign({}, split.photos);
    const ids = idsIn(state);
    if(ids.length){
      const p = await db.query(`SELECT photo_id, data FROM app_photos WHERE tenant_id = $1 AND photo_id = ANY($2::text[])`, [tenantId, ids]);
      p.rows.forEach(x => { photos[x.photo_id] = x.data; });
    }
    if(Object.keys(photos).length) state = Object.assign({}, state, { [PHOTO_KEY]: photos });
  }
  return { state, updatedAt: row.updated_at, deviceName: row.device_name || null };
}

async function keepCopy(db, tenantId, project, state, savedAt, deviceName, reason){
  const text = splitPhotos(state).state;
  await db.query(
    `INSERT INTO app_state_versions (id, tenant_id, project, state, saved_at, device_name, reason)
     VALUES ($1, $2, $3, $4::jsonb, $5, $6, $7)`,
    [crypto.randomUUID(), tenantId, project, JSON.stringify(text), savedAt, deviceName || null, reason]
  );
  await recordUse(db, tenantId, project, idsIn(text));
  // Only so many per project. Oldest go first.
  const r = await db.query(
    `SELECT id FROM app_state_versions WHERE tenant_id = $1 AND project = $2 ORDER BY kept_at DESC, saved_at DESC`, [tenantId, project]);
  for(const x of r.rows.slice(KEEP_MAX)) await db.query(`DELETE FROM app_state_versions WHERE id = $1`, [x.id]);
}

// Atomic: the caller holds a transaction.
//   msg { state, base, deviceId, deviceName, force }   state already without photos
// Returns { status: 'saved' | 'same' | 'conflict', updatedAt, deviceName }
async function saveState(db, tenantId, project, msg, userId){
  const found = await db.query(
    `SELECT state, updated_at, device_id, device_name FROM app_state
      WHERE tenant_id = $1 AND project = $2 FOR UPDATE`,
    [tenantId, project]
  );
  const cur = found.rows[0] || null;
  const decision = decideSave(cur, msg);
  if(decision === 'conflict') return { status: 'conflict', updatedAt: cur.updated_at, deviceName: cur.device_name || null };
  if(decision === 'same')     return { status: 'same', updatedAt: cur.updated_at, deviceName: cur.device_name || null };
  if(cur){
    // a report last saved by an older build may still carry its photos inside
    if(cur.state && cur.state[PHOTO_KEY]) await addPhotos(db, tenantId, project, splitPhotos(cur.state).photos, null);
    const last = await db.query(
      `SELECT kept_at FROM app_state_versions WHERE tenant_id = $1 AND project = $2 ORDER BY kept_at DESC LIMIT 1`, [tenantId, project]);
    if(keepVersion(cur, msg, last.rows.length ? last.rows[0].kept_at : null, Date.now())){
      await keepCopy(db, tenantId, project, cur.state, cur.updated_at, cur.device_name, 'earlier');
    }
  }
  // A time the server can hand back and compare exactly (whole milliseconds),
  // and always later than the version it replaces.
  let when = new Date();
  if(cur && when.getTime() <= new Date(cur.updated_at).getTime()) when = new Date(new Date(cur.updated_at).getTime() + 1);
  const r = await db.query(
    `INSERT INTO app_state (tenant_id, project, state, updated_at, updated_by, device_id, device_name)
     VALUES ($1, $2, $3::jsonb, $4, $5, $6, $7)
     ON CONFLICT (tenant_id, project) DO UPDATE
       SET state = EXCLUDED.state,
           updated_at = EXCLUDED.updated_at,
           updated_by = EXCLUDED.updated_by,
           device_id = EXCLUDED.device_id,
           device_name = EXCLUDED.device_name
     RETURNING updated_at`,
    [tenantId, project, JSON.stringify(msg.state), when, userId || null, msg.deviceId || null, msg.deviceName || null]
  );
  await recordUse(db, tenantId, project, idsIn(msg.state));
  return { status: 'saved', updatedAt: r.rows[0].updated_at, deviceName: msg.deviceName || null };
}

async function listVersions(db, tenantId, project){
  const r = await db.query(
    `SELECT id, saved_at, device_name, reason FROM app_state_versions
      WHERE tenant_id = $1 AND project = $2 ORDER BY kept_at DESC, saved_at DESC`, [tenantId, project]);
  return r.rows.map(x => ({ id: x.id, savedAt: x.saved_at, device: x.device_name || null, reason: x.reason }));
}

async function getVersion(db, tenantId, id){
  const r = await db.query(
    `SELECT project, state, saved_at FROM app_state_versions WHERE tenant_id = $1 AND id = $2`, [tenantId, id]);
  return r.rows.length ? { project: r.rows[0].project, state: r.rows[0].state, savedAt: r.rows[0].saved_at } : null;
}

// Atomic. Returns 'ok' | 'taken' | 'missing'
async function renameProject(db, tenantId, from, to){
  const taken = await db.query(`SELECT 1 AS ok FROM app_state WHERE tenant_id = $1 AND project = $2`, [tenantId, to]);
  if(taken.rows.length) return 'taken';
  const r = await db.query(`UPDATE app_state SET project = $3 WHERE tenant_id = $1 AND project = $2`, [tenantId, from, to]);
  if(!r.rowCount) return 'missing';
  await db.query(`UPDATE app_state_versions SET project = $3 WHERE tenant_id = $1 AND project = $2`, [tenantId, from, to]);
  await db.query(`UPDATE app_photo_use SET project = $3 WHERE tenant_id = $1 AND project = $2`, [tenantId, from, to]);
  return 'ok';
}

// Atomic. The one place a photo is removed: the project is deleted on
// purpose, and the photo is used by no other project.
async function deleteProject(db, tenantId, project){
  const r = await db.query(
    `DELETE FROM app_state WHERE tenant_id = $1 AND project = $2`,
    [tenantId, project]
  );
  await db.query(`DELETE FROM app_state_versions WHERE tenant_id = $1 AND project = $2`, [tenantId, project]);
  const mine = await db.query(`SELECT photo_id FROM app_photo_use WHERE tenant_id = $1 AND project = $2`, [tenantId, project]);
  const ids = mine.rows.map(x => x.photo_id);
  if(ids.length){
    const shared = await db.query(
      `SELECT photo_id FROM app_photo_use WHERE tenant_id = $1 AND project <> $2 AND photo_id = ANY($3::text[])`, [tenantId, project, ids]);
    const keep = new Set(shared.rows.map(x => x.photo_id));
    const gone = ids.filter(id => !keep.has(id));
    if(gone.length) await db.query(`DELETE FROM app_photos WHERE tenant_id = $1 AND photo_id = ANY($2::text[])`, [tenantId, gone]);
    await db.query(`DELETE FROM app_photo_use WHERE tenant_id = $1 AND project = $2`, [tenantId, project]);
  }
  return r.rowCount;
}

// Photos still inside reports saved before photos had their own rows are
// copied out. The reports themselves are left exactly as they are, so this is
// safe to run on every start; a report already done is skipped. One report at
// a time, so the server never holds more than one set of photos in memory.
// onlyTenant keeps the start-up check to its own rows.
async function copyLegacyPhotos(db, onlyTenant){
  const all = await db.query(
    `SELECT tenant_id, project FROM app_state
      WHERE photos_copied_at IS NULL AND state->'${PHOTO_KEY}' IS NOT NULL`);
  const rows = { rows: all.rows.filter(x => !onlyTenant || x.tenant_id === onlyTenant) };
  let photos = 0;
  for(const row of rows.rows){
    const one = await db.query(`SELECT state FROM app_state WHERE tenant_id = $1 AND project = $2`, [row.tenant_id, row.project]);
    if(!one.rows.length) continue;
    const split = splitPhotos(one.rows[0].state);
    photos += await addPhotos(db, row.tenant_id, row.project, split.photos, null);
    await recordUse(db, row.tenant_id, row.project, idsIn(split.state));
    await db.query(`UPDATE app_state SET photos_copied_at = NOW() WHERE tenant_id = $1 AND project = $2`, [row.tenant_id, row.project]);
  }
  return { reports: rows.rows.length, photos };
}

// ── start-up check ────────────────────────────────────────────
// Runs every statement above against the real database inside one
// transaction that is always rolled back, before the server listens. If the
// database disagrees with any of it the server does not start, the health
// check fails and the previous build carries on serving.
async function selfCheck(pool){
  const T = 'selfcheck-' + crypto.randomUUID(), P = 'Self check', pic = 'data:image/jpeg;base64,AAAA';
  const A = 'img-cap-1700000000001-aaaaaaaaa', B = 'img-quick-1700000000002-bbbbbbb', C = 'img-1700000000003-ccccccccc';
  const draft = ids => ({ 'AHS_REPORT_DRAFT_V1:/': JSON.stringify({ v: 2, t: 1, images: ids.map(id => ({ id })) }) });
  const must = (ok, what) => { if(!ok) throw new Error('self check: ' + what); };
  const db = await pool.connect();
  try {
    await db.query('BEGIN');
    await db.query(`INSERT INTO tenants (id, name) VALUES ($1, $2)`, [T, 'Self check']);
    must(await tenantExists(db, T), 'tenant not found');

    // a first save, then the same device carrying on
    let s = await saveState(db, T, P, { state: draft([A, B]), deviceId: 'one', deviceName: 'One' }, null);
    must(s.status === 'saved', 'first save');
    const v1 = s.updatedAt;
    s = await saveState(db, T, P, { state: draft([A, B, C]), base: v1, deviceId: 'one', deviceName: 'One' }, null);
    must(s.status === 'saved' && new Date(s.updatedAt) > new Date(v1), 'second save is not later than the first');
    const v2 = s.updatedAt;

    // another device, working from the older version, is asked first
    s = await saveState(db, T, P, { state: draft([A]), base: v1, deviceId: 'two', deviceName: 'Two' }, null);
    must(s.status === 'conflict' && s.deviceName === 'One', 'a stale save was not refused');
    s = await saveState(db, T, P, { state: draft([A]), base: v1, deviceId: 'two', deviceName: 'Two', force: true }, null);
    must(s.status === 'saved', 'a chosen copy was not saved');
    const vers = await listVersions(db, T, P);
    must(vers.length >= 1, 'what was replaced was not kept');
    const back = await getVersion(db, T, vers[0].id);
    must(back && idsIn(back.state).length === 3, 'the kept version does not read back');

    // photos: adding, never replacing; an empty list from an older build removes nothing
    must(await addPhotos(db, T, P, { [A]: pic, [B]: pic, 'not a photo': 'x' }, null) === 2, 'photos not added');
    await addPhotos(db, T, P, { [A]: pic + 'ZZZZ' }, null);
    must(await getPhoto(db, T, A) === pic, 'a photo was replaced');
    await addPhotos(db, T, P, splitPhotos({ [PHOTO_KEY]: {} }).photos, null);
    must((await havePhotos(db, T, [A, B, C])).sort().join() === [A, B].sort().join(), 'photos missing after an empty list');
    const inline = await loadState(db, T, P, true), plain = await loadState(db, T, P, false);
    must(inline && inline.state[PHOTO_KEY] && inline.state[PHOTO_KEY][A] === pic, 'an older build would not get its photos');
    must(plain && !plain.state[PHOTO_KEY], 'photos are still inside the report');

    // a report saved before photos had rows
    await db.query(`INSERT INTO app_state (tenant_id, project, state) VALUES ($1, $2, $3::jsonb)`,
      [T, 'Legacy', JSON.stringify(Object.assign(draft([C]), { [PHOTO_KEY]: { [C]: pic } }))]);
    const copied = await copyLegacyPhotos(db, T);
    must(copied.photos >= 1 && await getPhoto(db, T, C) === pic, 'photos inside an older report were not copied out');
    must((await copyLegacyPhotos(db, T)).reports === 0, 'an older report would be copied on every start');

    // rename carries everything; delete removes only what nothing else uses
    must(await renameProject(db, T, P, 'Legacy') === 'taken', 'a rename could overwrite another project');
    must(await renameProject(db, T, P, 'Renamed') === 'ok', 'rename');
    must((await listVersions(db, T, 'Renamed')).length === vers.length, 'earlier versions did not follow the rename');
    must((await listProjects(db, T)).length === 2, 'project list');
    must(await deleteProject(db, T, 'Renamed') === 1, 'delete');
    must((await havePhotos(db, T, [A, B, C])).join() === C, 'delete removed the wrong photos');
    must((await listVersions(db, T, 'Renamed')).length === 0, 'earlier versions outlived their project');
    return true;
  } finally {
    try { await db.query('ROLLBACK'); } catch(_){}
    db.release();
  }
}

module.exports = {
  addPhotos, havePhotos, getPhoto, recordUse,
  tenantExists, listProjects, loadState, saveState, keepCopy,
  listVersions, getVersion, renameProject, deleteProject,
  copyLegacyPhotos, selfCheck
};
