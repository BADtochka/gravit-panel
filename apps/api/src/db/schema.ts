export const schema = `
  PRAGMA foreign_keys = ON;
  PRAGMA journal_mode = WAL;

  CREATE TABLE IF NOT EXISTS jobs (
    id TEXT PRIMARY KEY,
    type TEXT NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('queued', 'running', 'succeeded', 'failed', 'cancelled')),
    progress INTEGER NOT NULL DEFAULT 0 CHECK (progress BETWEEN 0 AND 100),
    input_json TEXT NOT NULL,
    result_json TEXT,
    error TEXT,
    created_at TEXT NOT NULL,
    started_at TEXT,
    finished_at TEXT
  );

  CREATE INDEX IF NOT EXISTS jobs_created_at_idx ON jobs (created_at DESC);

  CREATE TABLE IF NOT EXISTS job_events (
    sequence INTEGER PRIMARY KEY AUTOINCREMENT,
    job_id TEXT NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
    type TEXT NOT NULL,
    message TEXT NOT NULL,
    progress INTEGER CHECK (progress IS NULL OR progress BETWEEN 0 AND 100),
    created_at TEXT NOT NULL
  );

  CREATE INDEX IF NOT EXISTS job_events_job_sequence_idx
    ON job_events (job_id, sequence);

  CREATE TABLE IF NOT EXISTS gravit_installations (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    path TEXT NOT NULL UNIQUE,
    address TEXT NOT NULL,
    project_name TEXT NOT NULL,
    source_repository TEXT NOT NULL,
    source_revision TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );

  CREATE INDEX IF NOT EXISTS gravit_installations_updated_at_idx
    ON gravit_installations (updated_at DESC);

  CREATE TABLE IF NOT EXISTS remote_control_credentials (
    installation_id TEXT PRIMARY KEY REFERENCES gravit_installations(id) ON DELETE CASCADE,
    endpoint TEXT NOT NULL,
    token_ciphertext TEXT NOT NULL,
    token_iv TEXT NOT NULL,
    token_auth_tag TEXT NOT NULL,
    source_revision TEXT NOT NULL,
    configured_at TEXT NOT NULL
  );
`
