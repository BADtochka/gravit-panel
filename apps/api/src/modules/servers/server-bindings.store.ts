import type {
  ProfileServerBinding,
  ServerBindingDeploymentState,
  ServerBindingInput,
} from '@gravit-panel/shared'
import type { Database } from 'bun:sqlite'

interface BindingRow {
  id: string
  installation_id: string
  profile_name: string
  server_name: string
  server_address: string
  server_port: number
  is_default: number
  auth_id: string
  pack_version_id: string | null
  xms: string
  xmx: string
  jvm_args_json: string
  game_args_json: string
  eula_accepted_at: string | null
  applied_pack_version_id: string | null
  updater_token_hash: string | null
  updater_installed_at: string | null
  updater_last_seen_at: string | null
  updater_error: string | null
  deployment_state: ServerBindingDeploymentState
  created_at: string
  updated_at: string
}

const parseArgs = (value: string) => {
  const parsed = JSON.parse(value) as unknown
  return Array.isArray(parsed)
    ? parsed.filter((item): item is string => typeof item === 'string')
    : []
}

const toBinding = (row: BindingRow): ProfileServerBinding => ({
  id: row.id,
  installationId: row.installation_id,
  profileName: row.profile_name,
  name: row.server_name,
  serverAddress: row.server_address,
  serverPort: row.server_port,
  isDefault: row.is_default === 1,
  protocol: -1,
  socketPing: true,
  authId: row.auth_id,
  packVersionId: row.pack_version_id,
  appliedPackVersionId: row.applied_pack_version_id,
  eulaAcceptedAt: row.eula_accepted_at,
  updaterInstalledAt: row.updater_installed_at,
  updaterLastSeenAt: row.updater_last_seen_at,
  updaterError: row.updater_error,
  xms: row.xms,
  xmx: row.xmx,
  jvmArgs: parseArgs(row.jvm_args_json),
  gameArgs: parseArgs(row.game_args_json),
  managed: true,
  deploymentState: row.deployment_state,
  updatedAt: row.updated_at,
})

export class ServerBindingsStore {
  constructor(private readonly db: Database) {}

  list(installationId: string, profileName: string): ProfileServerBinding[] {
    return this.db
      .query<BindingRow, [string, string]>(`
        SELECT * FROM server_bindings
        WHERE installation_id = ? AND profile_name = ?
        ORDER BY is_default DESC, server_name ASC
      `)
      .all(installationId, profileName)
      .map(toBinding)
  }

  get(id: string): ProfileServerBinding | null {
    const row = this.db
      .query<BindingRow, [string]>('SELECT * FROM server_bindings WHERE id = ?')
      .get(id)
    return row ? toBinding(row) : null
  }

  getByName(
    installationId: string,
    profileName: string,
    serverName: string,
  ): ProfileServerBinding | null {
    const row = this.db
      .query<BindingRow, [string, string, string]>(`
        SELECT * FROM server_bindings
        WHERE installation_id = ? AND profile_name = ? AND server_name = ?
      `)
      .get(installationId, profileName, serverName)
    return row ? toBinding(row) : null
  }

  save(
    input: ServerBindingInput,
    id: string = crypto.randomUUID(),
    state: ServerBindingDeploymentState = 'pending',
  ): ProfileServerBinding {
    const current = this.get(id)
    const now = new Date().toISOString()
    this.db.transaction(() => {
      if (input.isDefault) {
        this.db.query(`
          UPDATE server_bindings SET is_default = 0, updated_at = ?
          WHERE installation_id = ? AND profile_name = ? AND id <> ?
        `).run(now, input.installationId, input.profileName, id)
      }
      this.db.query(`
        INSERT INTO server_bindings (
          id, installation_id, profile_name, server_name, server_address,
          server_port, is_default, auth_id, pack_version_id, xms, xmx,
          jvm_args_json, game_args_json, deployment_state, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
          server_name = excluded.server_name,
          server_address = excluded.server_address,
          server_port = excluded.server_port,
          is_default = excluded.is_default,
          auth_id = excluded.auth_id,
          pack_version_id = excluded.pack_version_id,
          xms = excluded.xms,
          xmx = excluded.xmx,
          jvm_args_json = excluded.jvm_args_json,
          game_args_json = excluded.game_args_json,
          deployment_state = excluded.deployment_state,
          updated_at = excluded.updated_at
      `).run(
        id,
        input.installationId,
        input.profileName,
        input.name,
        input.serverAddress,
        input.serverPort,
        input.isDefault ? 1 : 0,
        input.authId,
        input.packVersionId,
        input.xms,
        input.xmx,
        JSON.stringify(input.jvmArgs),
        JSON.stringify(input.gameArgs),
        current ? 'requires-update' : state,
        current?.updatedAt ?? now,
        now,
      )
    })()
    const saved = this.get(id)
    if (!saved) throw new Error('Failed to persist server binding')
    return saved
  }

  setState(id: string, state: ServerBindingDeploymentState) {
    this.db.query(`
      UPDATE server_bindings SET deployment_state = ?, updated_at = ? WHERE id = ?
    `).run(state, new Date().toISOString(), id)
    return this.get(id)
  }

  acceptEula(id: string) {
    this.db.query(`
      UPDATE server_bindings
      SET eula_accepted_at = COALESCE(eula_accepted_at, ?), updated_at = ?
      WHERE id = ?
    `).run(new Date().toISOString(), new Date().toISOString(), id)
    return this.get(id)
  }

  setDesiredPack(id: string, packVersionId: string) {
    this.db.query(`
      UPDATE server_bindings
      SET pack_version_id = ?, deployment_state = 'requires-update', updated_at = ?
      WHERE id = ?
    `).run(packVersionId, new Date().toISOString(), id)
    return this.get(id)
  }

  saveUpdaterToken(id: string, tokenHash: string) {
    const now = new Date().toISOString()
    this.db.query(`
      UPDATE server_bindings SET
        updater_token_hash = ?, updater_installed_at = ?,
        updater_last_seen_at = ?, updater_error = NULL, updated_at = ?
      WHERE id = ?
    `).run(tokenHash, now, now, now, id)
    return this.get(id)
  }

  getByUpdaterTokenHash(tokenHash: string) {
    const row = this.db
      .query<BindingRow, [string]>(
        'SELECT * FROM server_bindings WHERE updater_token_hash = ?',
      )
      .get(tokenHash)
    return row ? toBinding(row) : null
  }

  touchUpdater(id: string) {
    const now = new Date().toISOString()
    this.db.query(`
      UPDATE server_bindings
      SET updater_last_seen_at = ?, updated_at = ?
      WHERE id = ?
    `).run(now, now, id)
    return this.get(id)
  }

  reportPack(id: string, packVersionId: string | null, error?: string) {
    const now = new Date().toISOString()
    this.db.query(`
      UPDATE server_bindings SET
        applied_pack_version_id = CASE WHEN ? IS NULL THEN applied_pack_version_id ELSE ? END,
        updater_last_seen_at = ?, updater_error = ?,
        deployment_state = CASE WHEN ? IS NULL THEN 'installed' ELSE 'failed' END,
        updated_at = ?
      WHERE id = ?
    `).run(
      packVersionId,
      packVersionId,
      now,
      error?.slice(0, 2000) ?? null,
      error ?? null,
      now,
      id,
    )
    return this.get(id)
  }

  delete(id: string) {
    return this.db.query('DELETE FROM server_bindings WHERE id = ?').run(id).changes > 0
  }
}
