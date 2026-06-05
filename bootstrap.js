// ══════════════════════════════════════════════════════════════
//  Bootstrap — one-time setup tasks run on server startup.
//
//  1. Ensures a default tenant exists ('archer') so the front-end can
//     save state immediately (this is a sole-consultant tool; projects
//     are used to separate sites/inspections within that tenant).
//  2. Creates the first consultant user from ADMIN_EMAIL / ADMIN_PASSWORD
//     if no consultant exists yet. After first login you can change the
//     password in-app and remove ADMIN_PASSWORD from the environment.
// ══════════════════════════════════════════════════════════════
const crypto   = require('crypto');
const bcrypt   = require('bcryptjs');
const { pool } = require('./db');

const DEFAULT_TENANT_ID   = 'archer';
const DEFAULT_TENANT_NAME = 'Archer Health & Safety';

async function bootstrap(){
  // 1) Default tenant (idempotent) — lets the app persist state out of the box.
  await pool.query(
    `INSERT INTO tenants (id, name) VALUES ($1, $2)
     ON CONFLICT (id) DO NOTHING`,
    [DEFAULT_TENANT_ID, DEFAULT_TENANT_NAME]
  );

  // 2) First consultant user from env (only if none exists yet).
  const adminEmail    = (process.env.ADMIN_EMAIL    || '').trim().toLowerCase();
  const adminPassword =  process.env.ADMIN_PASSWORD || '';
  const adminName     = (process.env.ADMIN_NAME     || '').trim();

  if(!adminEmail || !adminPassword){
    console.log('• Bootstrap: default tenant ensured; admin seed skipped (ADMIN_EMAIL / ADMIN_PASSWORD not set)');
    return;
  }

  const existing = await pool.query(
    `SELECT id FROM users WHERE role = 'consultant' LIMIT 1`
  );
  if(existing.rows.length){
    console.log('• Bootstrap: a consultant already exists — admin seed skipped');
    return;
  }

  if(!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(adminEmail)){
    console.warn('• Bootstrap skipped: ADMIN_EMAIL is not a valid email');
    return;
  }
  if(adminPassword.length < 8){
    console.warn('• Bootstrap skipped: ADMIN_PASSWORD must be at least 8 characters');
    return;
  }

  const id   = crypto.randomUUID();
  const hash = await bcrypt.hash(adminPassword, 10);
  await pool.query(
    `INSERT INTO users (id, email, password_hash, tenant_id, role, display_name)
     VALUES ($1, $2, $3, NULL, 'consultant', $4)`,
    [id, adminEmail, hash, adminName || null]
  );
  console.log(`✓ Bootstrap created consultant user: ${adminEmail}`);
  console.log('  → After first login, remove ADMIN_PASSWORD from the environment');
}

module.exports = { bootstrap };
