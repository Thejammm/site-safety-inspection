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
