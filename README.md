# AHS Site Safety Inspection

Auth-protected, server-saved version of the AHS Site Inspection Report.
Built the same way as the CDM Risk Register and Workplace Inspection apps:
a single Node/Express service serves the front-end **and** a multi-tenant API,
with per-(tenant, project) state stored as JSONB in PostgreSQL.

## Offline / standalone
`public/index.html` is the original single-file app and **still works opened
directly from disk with no internet** (data in `localStorage`, persisted in the
file). The server-sync layer is **additive**: it only activates when the page is
served over http(s) **and** the user signs in. Offline or signed out → pure local.

## Endpoints
- `GET /healthz` → `200 {ok,db}` (used by the deploy health check)
- `POST /api/auth/login` · `POST /api/auth/logout` · `GET /api/auth/me` · `POST /api/auth/change-password`
- `GET /api/state` · `POST /api/state` · `GET /api/state/projects`

## Run locally
```
npm install
# create .env from .env.example (set SESSION_SECRET, DATABASE_URL, ADMIN_*)
npm run dev
```

## Deploy (Coolify)
- Build pack: Nixpacks · Port: 3000 · Health check: `GET /healthz` → 200
- Env: `DATABASE_URL`, `SESSION_SECRET`, `NODE_ENV=production`, `PORT=3000`,
  and first-run `ADMIN_EMAIL` / `ADMIN_PASSWORD` / `ADMIN_NAME`.
- Schema is created automatically on boot (idempotent); a default tenant `archer`
  is seeded so saves work immediately.
