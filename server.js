// ══════════════════════════════════════════════════════════════
//  AHS Site Safety Inspection — server
//
//  - Serves the single-file front-end (public/index.html) which also
//    works standalone offline from disk; server-saving is additive.
//  - Postgres-backed per-(tenant, project) state (one JSONB blob).
//  - Email/password auth with JWT in an httpOnly cookie.
//  - Bootstrap seeds a default tenant + a consultant user on first run.
//
//  Architecture mirrors the CDM Risk Register and Workplace Inspection
//  apps — a single Node service serves the static front-end AND the API.
// ══════════════════════════════════════════════════════════════
const express      = require('express');
const cookieParser = require('cookie-parser');
const path         = require('path');

const { migrate, isHealthy } = require('./db');
const { bootstrap }          = require('./bootstrap');
const authRoutes             = require('./routes/auth');
const stateRoutes            = require('./routes/state');
const adminRoutes            = require('./routes/admin');

const app  = express();
const PORT = parseInt(process.env.PORT, 10) || 3000;
const HOST = '0.0.0.0';

// Trust the reverse proxy (Coolify/Traefik) so req.protocol / req.ip work
app.set('trust proxy', 1);

// ── Middleware ────────────────────────────────────────────────
app.use(cookieParser());
app.use(express.json({ limit: '50mb' }));

// ── Health check ──────────────────────────────────────────────
app.get('/healthz', async (_req, res) => {
  const dbOk = await isHealthy();
  if(!dbOk) return res.status(503).json({ ok: false, db: false });
  res.json({ ok: true, db: true, ts: new Date().toISOString() });
});

// ── API routes ────────────────────────────────────────────────
app.use('/api/auth',  authRoutes);
app.use('/api/state', stateRoutes);
app.use('/api/admin', adminRoutes);

app.use('/api', (_req, res) => {
  res.status(404).json({ error: 'not_found' });
});

// ── Static front-end ──────────────────────────────────────────
app.use(express.static(path.join(__dirname, 'public'), {
  extensions: ['html'],
  setHeaders: (res, filePath) => {
    if(/\.html$/i.test(filePath)){
      res.setHeader('Cache-Control', 'no-cache, must-revalidate');
    } else {
      res.setHeader('Cache-Control', 'public, max-age=300');
    }
  }
}));

// SPA fallback — any other route serves index.html (also no-cache)
app.get('*', (_req, res) => {
  res.setHeader('Cache-Control', 'no-cache, must-revalidate');
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ── Startup sequence ──────────────────────────────────────────
(async () => {
  try {
    await migrate();
    await bootstrap();
    app.listen(PORT, HOST, () => {
      console.log(`✓ Site Safety Inspection listening on http://${HOST}:${PORT}`);
    });
  } catch(err){
    console.error('FATAL: startup failed:', err);
    process.exit(1);
  }
})();
