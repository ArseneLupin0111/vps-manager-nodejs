-- Local agent upgrade jobs, updater heartbeats, and credential scoping.
--
-- 1. agent_credentials.scope separates the metrics/agent credential from the
--    local-updater credential (default keeps every existing credential an
--    agent credential).
-- 2. agent_states.build_id records the full-git-SHA build identity reported
--    by heartbeat ingest (cleared when a heartbeat omits it).
-- 3. updater_heartbeats tracks the last claim poll per local VPS so the
--    dashboard can report updater installed/healthy.
-- 4. local_agent_upgrade_jobs is the durable job store: CAS-safe revisions,
--    lease + fencing token, per-phase and overall deadlines, pinned target
--    release identity, and the verbatim signed manifest.

ALTER TABLE agent_credentials
  ADD COLUMN IF NOT EXISTS scope text NOT NULL DEFAULT 'agent';

ALTER TABLE agent_states
  ADD COLUMN IF NOT EXISTS build_id text;

CREATE TABLE IF NOT EXISTS updater_heartbeats (
  vps_id text PRIMARY KEY REFERENCES vps(id) ON DELETE CASCADE,
  last_seen_at timestamptz NOT NULL,
  credential_id text
);

CREATE TABLE IF NOT EXISTS local_agent_upgrade_jobs (
  id text PRIMARY KEY,
  vps_id text NOT NULL REFERENCES vps(id) ON DELETE CASCADE,
  state text NOT NULL CHECK (state IN (
    'queued', 'claimed', 'downloading', 'verifying', 'staging',
    'restarting', 'awaiting_heartbeat', 'rolling_back',
    'succeeded', 'rolled_back', 'rollback_unverified', 'failed'
  )),
  progress smallint CHECK (progress IS NULL OR (progress >= 0 AND progress <= 100)),
  release_id text NOT NULL,
  release_version text NOT NULL,
  release_build_id text NOT NULL,
  target_sha256 text NOT NULL,
  target_url text NOT NULL,
  target_size_bytes bigint,
  manifest_raw text NOT NULL,
  baseline_build_id text,
  baseline_heartbeat_at timestamptz,
  actor text NOT NULL,
  idempotency_key text,
  fencing_token bigint NOT NULL DEFAULT 1,
  reclaim_count integer NOT NULL DEFAULT 0,
  claimed_at timestamptz,
  lease_expires_at timestamptz,
  deadline_at timestamptz NOT NULL,
  phase_deadline_at timestamptz,
  message text,
  error_code text,
  error_message text,
  result jsonb,
  revision integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  completed_at timestamptz
);

-- Exactly one live job per VPS (unique active-job constraint).
CREATE UNIQUE INDEX IF NOT EXISTS local_agent_upgrade_jobs_active
  ON local_agent_upgrade_jobs (vps_id)
  WHERE state NOT IN ('succeeded', 'rolled_back', 'rollback_unverified', 'failed');

-- Idempotent create: the same key always maps to the same job.
CREATE UNIQUE INDEX IF NOT EXISTS local_agent_upgrade_jobs_idem
  ON local_agent_upgrade_jobs (vps_id, idempotency_key)
  WHERE idempotency_key IS NOT NULL;

CREATE INDEX IF NOT EXISTS local_agent_upgrade_jobs_vps_created
  ON local_agent_upgrade_jobs (vps_id, created_at DESC);
