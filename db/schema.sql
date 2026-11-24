-- ══════════════════════════════════════════════════════════════
--  Workplace Inspection System — Database Schema
--  Run automatically on server startup. Idempotent.
-- ══════════════════════════════════════════════════════════════

-- Tenants: each client business is one tenant.
-- A consultant user has tenant_id NULL (sees all tenants).
CREATE TABLE IF NOT EXISTS tenants (
  id           TEXT PRIMARY KEY,           -- e.g. 'easy-travel'
  name         TEXT NOT NULL,              -- display name e.g. 'Easy Travel Leeds'
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Users: anyone who can log in.
-- role = 'consultant' → can see/manage all tenants (Archer staff)
-- role = 'client_user' → scoped to one tenant
CREATE TABLE IF NOT EXISTS users (
  id            TEXT PRIMARY KEY,
  email         TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  tenant_id     TEXT REFERENCES tenants(id) ON DELETE SET NULL,
  role          TEXT NOT NULL CHECK (role IN ('consultant', 'client_user')),
  display_name  TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_login_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_users_email  ON users (LOWER(email));
CREATE INDEX IF NOT EXISTS idx_users_tenant ON users (tenant_id);

-- App state: one row per (tenant, project). Each client (tenant) can keep
-- multiple named projects, each holding its own register blob (JSONB).
-- The client picks/types the project name at login and their work is saved
-- and resumed under that name.
CREATE TABLE IF NOT EXISTS app_state (
  tenant_id   TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  project     TEXT NOT NULL DEFAULT 'Default Project',
  state       JSONB NOT NULL DEFAULT '{}'::jsonb,
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_by  TEXT REFERENCES users(id) ON DELETE SET NULL,
  PRIMARY KEY (tenant_id, project)
);

-- Upgrade path for databases created before projects existed:
-- add the `project` column and widen the primary key to (tenant_id, project).
-- Idempotent: a no-op once the table is already in the new shape.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_name = 'app_state' AND column_name = 'project'
  ) THEN
    ALTER TABLE app_state ADD COLUMN project TEXT NOT NULL DEFAULT 'Default Project';
  END IF;

  -- If the primary key is still the old single-column (tenant_id) key, replace it.
  IF EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'app_state'::regclass
       AND contype  = 'p'
       AND array_length(conkey, 1) = 1
  ) THEN
    ALTER TABLE app_state DROP CONSTRAINT app_state_pkey;
    ALTER TABLE app_state ADD PRIMARY KEY (tenant_id, project);
  END IF;
END $$;

-- What Compass says each client still needs evidence for: the open
-- accreditation questions a site inspection can evidence. Written by
-- Compass through /api/link/evidence, read by the inspector's visit details.
-- Keyed by the client reference typed against a project (lower-cased).
CREATE TABLE IF NOT EXISTS link_focus (
  client      TEXT PRIMARY KEY,
  focus       JSONB NOT NULL DEFAULT '[]'::jsonb,
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Report photos: one row each, keyed by the photo's own id. A save can only
-- add to this table (routes/store.js). A row goes only when a project that
-- used it is deleted on purpose and no other project uses it.
CREATE TABLE IF NOT EXISTS app_photos (
  tenant_id   TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  photo_id    TEXT NOT NULL,
  data        TEXT NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_by  TEXT,
  PRIMARY KEY (tenant_id, photo_id)
);

-- Which projects use which photos (a project saved under a second name uses
-- the same ones). Added to on every save, never taken from.
CREATE TABLE IF NOT EXISTS app_photo_use (
  tenant_id   TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  project     TEXT NOT NULL,
  photo_id    TEXT NOT NULL,
  PRIMARY KEY (tenant_id, project, photo_id)
);

-- Which device last saved a project, so a save from an out-of-date copy can be
-- told apart from a device carrying on with its own work.
ALTER TABLE app_state ADD COLUMN IF NOT EXISTS device_id TEXT;
ALTER TABLE app_state ADD COLUMN IF NOT EXISTS device_name TEXT;
ALTER TABLE app_state ADD COLUMN IF NOT EXISTS photos_copied_at TIMESTAMPTZ;

-- Earlier versions of each project (text only, photos stay in app_photos).
CREATE TABLE IF NOT EXISTS app_state_versions (
  id           TEXT PRIMARY KEY,
  tenant_id    TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  project      TEXT NOT NULL,
  state        JSONB NOT NULL,
  saved_at     TIMESTAMPTZ NOT NULL,
  device_name  TEXT,
  reason       TEXT NOT NULL DEFAULT 'earlier',
  kept_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_versions_project ON app_state_versions (tenant_id, project, kept_at);
