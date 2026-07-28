import type { MinecraftLoader, ServerPackVersion } from '@gravit-panel/shared'
import type { Database } from 'bun:sqlite'

interface VersionRow {
  id: string
  installation_id: string
  profile_name: string
  binding_id: string | null
  minecraft_version: string
  loader: MinecraftLoader
  loader_version: string | null
  version_number: number
  file_count: number
  size: number
  sha256: string
  archive_path: string
  manifest_json: string
  created_at: string
}

const toVersion = (row: VersionRow): ServerPackVersion => ({
  id: row.id,
  installationId: row.installation_id,
  profileName: row.profile_name,
  bindingId: row.binding_id,
  minecraftVersion: row.minecraft_version,
  loader: row.loader,
  loaderVersion: row.loader_version,
  versionNumber: row.version_number,
  fileCount: row.file_count,
  size: row.size,
  sha256: row.sha256,
  createdAt: row.created_at,
})

export class ServerPackStore {
  constructor(private readonly db: Database) {}

  list(installationId: string, bindingId: string) {
    return this.db
      .query<VersionRow, [string, string]>(`
        SELECT * FROM server_pack_versions
        WHERE installation_id = ? AND binding_id = ?
        ORDER BY version_number DESC
      `)
      .all(installationId, bindingId)
      .map(toVersion)
  }

  get(id: string) {
    const row = this.getRow(id)
    return row ? toVersion(row) : null
  }

  archivePath(id: string) {
    return this.getRow(id)?.archive_path ?? null
  }

  manifest(id: string) {
    const row = this.getRow(id)
    if (!row) return null
    return JSON.parse(row.manifest_json) as {
      files?: Array<{ path: string; size: number; sha256: string }>
    }
  }

  create(input: {
    installationId: string
    profileName: string
    bindingId: string
    minecraftVersion: string
    loader: MinecraftLoader
    loaderVersion: string | null
    fileCount: number
    size: number
    sha256: string
    archivePath: string
    manifest: Record<string, unknown>
  }) {
    const versionNumber =
      (this.db
        .query<{ value: number }, [string, string]>(`
          SELECT COALESCE(MAX(version_number), 0) + 1 AS value
          FROM server_pack_versions
          WHERE installation_id = ? AND profile_name = ?
        `)
        .get(input.installationId, input.profileName)?.value ?? 1)
    const id = crypto.randomUUID()
    const createdAt = new Date().toISOString()
    this.db.query(`
      INSERT INTO server_pack_versions (
        id, installation_id, profile_name, binding_id, minecraft_version, loader,
        loader_version, version_number, file_count, size, sha256,
        archive_path, manifest_json, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id,
      input.installationId,
      input.profileName,
      input.bindingId,
      input.minecraftVersion,
      input.loader,
      input.loaderVersion,
      versionNumber,
      input.fileCount,
      input.size,
      input.sha256,
      input.archivePath,
      JSON.stringify(input.manifest),
      createdAt,
    )
    const version = this.get(id)
    if (!version) throw new Error('Failed to persist server pack version')
    return version
  }

  private getRow(id: string) {
    return this.db
      .query<VersionRow, [string]>('SELECT * FROM server_pack_versions WHERE id = ?')
      .get(id)
  }
}
