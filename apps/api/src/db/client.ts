import { Database } from 'bun:sqlite'
import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { env } from '../core/env'
import { schema } from './schema'

if (env.DATABASE_PATH !== ':memory:') {
  mkdirSync(dirname(env.DATABASE_PATH), { recursive: true })
}

export const database = new Database(env.DATABASE_PATH, { create: true })
database.exec(schema)

const ensureColumn = (table: string, column: string, declaration: string) => {
  const columns = database
    .query<{ name: string }, []>(`PRAGMA table_info(${table})`)
    .all()
  if (!columns.some((item) => item.name === column)) {
    database.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${declaration}`)
  }
}

ensureColumn('server_bindings', 'eula_accepted_at', 'TEXT')
ensureColumn('server_bindings', 'applied_pack_version_id', 'TEXT')
ensureColumn('server_bindings', 'updater_token_hash', 'TEXT')
ensureColumn('server_bindings', 'updater_installed_at', 'TEXT')
ensureColumn('server_bindings', 'updater_last_seen_at', 'TEXT')
ensureColumn('server_bindings', 'updater_error', 'TEXT')
ensureColumn('server_pack_versions', 'binding_id', 'TEXT REFERENCES server_bindings(id) ON DELETE CASCADE')
database.exec(`
  CREATE INDEX IF NOT EXISTS server_pack_versions_binding_idx
  ON server_pack_versions (binding_id, version_number DESC)
`)

const jobsTable = database
  .query<{ sql: string }, []>(
    "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'jobs'",
  )
  .get()
if (jobsTable && !jobsTable.sql.includes("'cancelled'")) {
  database.exec('PRAGMA foreign_keys = OFF')
  try {
    database.exec(`
      BEGIN IMMEDIATE;
      DROP TABLE IF EXISTS jobs_with_cancellation;
      CREATE TABLE jobs_with_cancellation (
        id TEXT PRIMARY KEY,
        type TEXT NOT NULL,
        status TEXT NOT NULL CHECK (
          status IN ('queued', 'running', 'succeeded', 'failed', 'cancelled')
        ),
        progress INTEGER NOT NULL DEFAULT 0 CHECK (progress BETWEEN 0 AND 100),
        input_json TEXT NOT NULL,
        result_json TEXT,
        error TEXT,
        created_at TEXT NOT NULL,
        started_at TEXT,
        finished_at TEXT
      );
      INSERT INTO jobs_with_cancellation
      SELECT
        id, type, status, progress, input_json, result_json, error,
        created_at, started_at, finished_at
      FROM jobs;
      DROP TABLE jobs;
      ALTER TABLE jobs_with_cancellation RENAME TO jobs;
      CREATE INDEX jobs_created_at_idx ON jobs (created_at DESC);
      COMMIT;
    `)
  } catch (error) {
    if (database.inTransaction) database.exec('ROLLBACK')
    throw error
  } finally {
    database.exec('PRAGMA foreign_keys = ON')
  }
}
