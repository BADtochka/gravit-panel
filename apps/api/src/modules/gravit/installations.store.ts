import type { GravitInstallation, LauncherDockeredInstallResult } from '@gravit-panel/shared'
import type { Database } from 'bun:sqlite'

interface InstallationRow {
  id: string
  name: string
  path: string
  address: string
  project_name: string
  source_repository: string
  source_revision: string
  created_at: string
  updated_at: string
}

const toInstallation = (row: InstallationRow): GravitInstallation => ({
  id: row.id,
  name: row.name,
  path: row.path,
  address: row.address,
  projectName: row.project_name,
  sourceRepository: row.source_repository,
  sourceRevision: row.source_revision,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
})

export class InstallationsStore {
  constructor(private readonly db: Database) {}

  upsert(name: string, result: LauncherDockeredInstallResult): GravitInstallation {
    const current = this.getByPath(result.installationPath)
    const now = new Date().toISOString()
    const id = current?.id ?? crypto.randomUUID()
    const createdAt = current?.createdAt ?? now

    this.db
      .query(`
        INSERT INTO gravit_installations (
          id, name, path, address, project_name, source_repository,
          source_revision, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(path) DO UPDATE SET
          name = excluded.name,
          address = excluded.address,
          project_name = excluded.project_name,
          source_repository = excluded.source_repository,
          source_revision = excluded.source_revision,
          updated_at = excluded.updated_at
      `)
      .run(
        id,
        name,
        result.installationPath,
        result.address,
        result.projectName,
        result.sourceRepository,
        result.sourceRevision,
        createdAt,
        now,
      )

    const installation = this.get(id)
    if (!installation) throw new Error('Failed to persist LauncherDockered installation')
    return installation
  }

  get(id: string): GravitInstallation | null {
    const row = this.db
      .query<InstallationRow, [string]>('SELECT * FROM gravit_installations WHERE id = ?')
      .get(id)
    return row ? toInstallation(row) : null
  }

  list(): GravitInstallation[] {
    return this.db
      .query<InstallationRow, []>('SELECT * FROM gravit_installations ORDER BY updated_at DESC')
      .all()
      .map(toInstallation)
  }

  delete(id: string): boolean {
    const result = this.db
      .query('DELETE FROM gravit_installations WHERE id = ?')
      .run(id)
    return result.changes >= 1
  }

  private getByPath(path: string): GravitInstallation | null {
    const row = this.db
      .query<InstallationRow, [string]>('SELECT * FROM gravit_installations WHERE path = ?')
      .get(path)
    return row ? toInstallation(row) : null
  }
}
