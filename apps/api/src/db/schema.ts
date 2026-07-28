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

  CREATE TABLE IF NOT EXISTS panel_oauth_states (
    state_hash TEXT PRIMARY KEY,
    expires_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS panel_sessions (
    session_hash TEXT PRIMARY KEY,
    discord_id TEXT NOT NULL,
    username TEXT NOT NULL,
    global_name TEXT,
    avatar_hash TEXT,
    expires_at TEXT NOT NULL,
    created_at TEXT NOT NULL
  );

  CREATE INDEX IF NOT EXISTS panel_sessions_expires_at_idx
    ON panel_sessions (expires_at);

  CREATE TABLE IF NOT EXISTS server_bindings (
    id TEXT PRIMARY KEY,
    installation_id TEXT NOT NULL REFERENCES gravit_installations(id) ON DELETE CASCADE,
    profile_name TEXT NOT NULL,
    server_name TEXT NOT NULL,
    server_address TEXT NOT NULL,
    server_port INTEGER NOT NULL CHECK (server_port BETWEEN 1 AND 65535),
    is_default INTEGER NOT NULL CHECK (is_default IN (0, 1)),
    auth_id TEXT NOT NULL,
    pack_version_id TEXT REFERENCES server_pack_versions(id) ON DELETE SET NULL,
    xms TEXT NOT NULL,
    xmx TEXT NOT NULL,
    jvm_args_json TEXT NOT NULL,
    game_args_json TEXT NOT NULL,
    deployment_state TEXT NOT NULL CHECK (
      deployment_state IN ('pending', 'ready', 'requires-update', 'installed', 'failed')
    ),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    UNIQUE (installation_id, profile_name, server_name)
  );

  CREATE INDEX IF NOT EXISTS server_bindings_profile_idx
    ON server_bindings (installation_id, profile_name, updated_at DESC);

  CREATE TABLE IF NOT EXISTS server_pack_versions (
    id TEXT PRIMARY KEY,
    installation_id TEXT NOT NULL REFERENCES gravit_installations(id) ON DELETE CASCADE,
    profile_name TEXT NOT NULL,
    minecraft_version TEXT NOT NULL,
    loader TEXT NOT NULL,
    loader_version TEXT,
    version_number INTEGER NOT NULL,
    file_count INTEGER NOT NULL,
    size INTEGER NOT NULL,
    sha256 TEXT NOT NULL,
    archive_path TEXT NOT NULL,
    manifest_json TEXT NOT NULL,
    created_at TEXT NOT NULL,
    UNIQUE (installation_id, profile_name, version_number)
  );

  CREATE INDEX IF NOT EXISTS server_pack_versions_profile_idx
    ON server_pack_versions (installation_id, profile_name, version_number DESC);

  CREATE TABLE IF NOT EXISTS server_bootstrap_drafts (
    id TEXT PRIMARY KEY,
    binding_id TEXT NOT NULL REFERENCES server_bindings(id) ON DELETE CASCADE,
    installation_id TEXT NOT NULL REFERENCES gravit_installations(id) ON DELETE CASCADE,
    profile_name TEXT NOT NULL,
    server_name TEXT NOT NULL,
    status TEXT NOT NULL CHECK (
      status IN ('preparing', 'ready', 'issued', 'claimed', 'installed', 'failed')
    ),
    error TEXT,
    config_json TEXT NOT NULL,
    bundle_path TEXT,
    bundle_sha256 TEXT,
    jre_x64_path TEXT,
    jre_x64_sha256 TEXT,
    jre_aarch64_path TEXT,
    jre_aarch64_sha256 TEXT,
    claim_hash TEXT UNIQUE,
    claim_expires_at TEXT,
    artifact_hash TEXT UNIQUE,
    artifact_expires_at TEXT,
    report_hash TEXT UNIQUE,
    created_at TEXT NOT NULL,
    prepared_at TEXT,
    issued_at TEXT,
    claimed_at TEXT,
    installed_at TEXT
  );

  CREATE INDEX IF NOT EXISTS server_bootstrap_binding_idx
    ON server_bootstrap_drafts (binding_id, created_at DESC);
`
