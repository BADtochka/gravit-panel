import type { ServerBootstrapDraft, ServerBootstrapStatus } from '@gravit-panel/shared'
import { createHash, randomBytes } from 'node:crypto'
import type { Database } from 'bun:sqlite'

interface DraftRow {
  id: string
  binding_id: string
  installation_id: string
  profile_name: string
  server_name: string
  status: ServerBootstrapStatus
  error: string | null
  config_json: string
  bundle_path: string | null
  bundle_sha256: string | null
  jre_x64_path: string | null
  jre_x64_sha256: string | null
  jre_aarch64_path: string | null
  jre_aarch64_sha256: string | null
  claim_hash: string | null
  claim_expires_at: string | null
  artifact_hash: string | null
  artifact_expires_at: string | null
  report_hash: string | null
  created_at: string
  prepared_at: string | null
  issued_at: string | null
  claimed_at: string | null
  installed_at: string | null
}

const hashToken = (value: string) => createHash('sha256').update(value).digest('hex')
const randomToken = () => randomBytes(32).toString('base64url')

const toDraft = (row: DraftRow): ServerBootstrapDraft => ({
  id: row.id,
  bindingId: row.binding_id,
  installationId: row.installation_id,
  profileName: row.profile_name,
  serverName: row.server_name,
  status: row.status,
  error: row.error,
  createdAt: row.created_at,
  preparedAt: row.prepared_at,
  issuedAt: row.issued_at,
  claimedAt: row.claimed_at,
  installedAt: row.installed_at,
})

export class ServerBootstrapStore {
  constructor(private readonly db: Database) {}

  create(input: {
    bindingId: string
    installationId: string
    profileName: string
    serverName: string
    config: Record<string, unknown>
  }) {
    const id = crypto.randomUUID()
    const createdAt = new Date().toISOString()
    this.db.query(`
      INSERT INTO server_bootstrap_drafts (
        id, binding_id, installation_id, profile_name, server_name,
        status, config_json, created_at
      ) VALUES (?, ?, ?, ?, ?, 'preparing', ?, ?)
    `).run(
      id,
      input.bindingId,
      input.installationId,
      input.profileName,
      input.serverName,
      JSON.stringify(input.config),
      createdAt,
    )
    return this.get(id)!
  }

  get(id: string) {
    const row = this.row(id)
    return row ? toDraft(row) : null
  }

  internal(id: string) {
    return this.row(id)
  }

  list(bindingId: string) {
    return this.db
      .query<DraftRow, [string]>(`
        SELECT * FROM server_bootstrap_drafts
        WHERE binding_id = ? ORDER BY created_at DESC
      `)
      .all(bindingId)
      .map(toDraft)
  }

  invalidateBinding(bindingId: string, reason: string) {
    this.db.query(`
      UPDATE server_bootstrap_drafts SET
        status = 'failed', error = ?,
        claim_hash = NULL, claim_expires_at = NULL,
        artifact_hash = NULL, artifact_expires_at = NULL,
        report_hash = NULL
      WHERE binding_id = ? AND status IN ('preparing', 'ready', 'issued', 'claimed')
    `).run(reason.slice(0, 2000), bindingId)
  }

  ready(id: string, artifacts: {
    bundlePath: string
    bundleSha256: string
    jreX64Path: string
    jreX64Sha256: string
    jreAarch64Path: string
    jreAarch64Sha256: string
    config: Record<string, unknown>
  }) {
    const preparedAt = new Date().toISOString()
    this.db.query(`
      UPDATE server_bootstrap_drafts SET
        status = 'ready', error = NULL, config_json = ?,
        bundle_path = ?, bundle_sha256 = ?,
        jre_x64_path = ?, jre_x64_sha256 = ?,
        jre_aarch64_path = ?, jre_aarch64_sha256 = ?,
        prepared_at = ?
      WHERE id = ?
    `).run(
      JSON.stringify(artifacts.config),
      artifacts.bundlePath,
      artifacts.bundleSha256,
      artifacts.jreX64Path,
      artifacts.jreX64Sha256,
      artifacts.jreAarch64Path,
      artifacts.jreAarch64Sha256,
      preparedAt,
      id,
    )
    return this.get(id)
  }

  fail(id: string, error: string) {
    this.db.query(`
      UPDATE server_bootstrap_drafts SET status = 'failed', error = ? WHERE id = ?
    `).run(error.slice(0, 2000), id)
    return this.get(id)
  }

  issue(id: string) {
    const draft = this.row(id)
    if (!draft || draft.status !== 'ready') {
      throw new Error('Bootstrap draft is not ready for issuance')
    }
    const claim = randomToken()
    const expiresAt = new Date(Date.now() + 15 * 60_000).toISOString()
    this.db.query(`
      UPDATE server_bootstrap_drafts SET
        status = 'issued', claim_hash = ?, claim_expires_at = ?,
        artifact_hash = NULL, artifact_expires_at = NULL, report_hash = NULL,
        issued_at = ?
      WHERE id = ?
    `).run(hashToken(claim), expiresAt, new Date().toISOString(), id)
    return { claim, expiresAt, draft: this.get(id)! }
  }

  beginClaim(claim: string) {
    const now = new Date().toISOString()
    const row = this.db
      .query<DraftRow, [string, string]>(`
        SELECT * FROM server_bootstrap_drafts
        WHERE claim_hash = ? AND status = 'issued' AND claim_expires_at > ?
      `)
      .get(hashToken(claim), now)
    if (!row) return null
    const locked = this.db.query(`
      UPDATE server_bootstrap_drafts SET status = 'claimed', claimed_at = ?
      WHERE id = ? AND status = 'issued'
    `).run(now, row.id)
    return locked.changes === 1 ? this.row(row.id) : null
  }

  claimInstallationId(claim: string) {
    return this.db
      .query<{ installation_id: string }, [string, string]>(`
        SELECT installation_id FROM server_bootstrap_drafts
        WHERE claim_hash = ? AND status = 'issued' AND claim_expires_at > ?
      `)
      .get(hashToken(claim), new Date().toISOString())?.installation_id ?? null
  }

  completeClaim(id: string) {
    const artifactToken = randomToken()
    const reportToken = randomToken()
    const artifactExpiresAt = new Date(Date.now() + 30 * 60_000).toISOString()
    this.db.query(`
      UPDATE server_bootstrap_drafts SET
        artifact_hash = ?, artifact_expires_at = ?, report_hash = ?,
        claim_hash = NULL, claim_expires_at = NULL
      WHERE id = ? AND status = 'claimed'
    `).run(
      hashToken(artifactToken),
      artifactExpiresAt,
      hashToken(reportToken),
      id,
    )
    return { artifactToken, reportToken, artifactExpiresAt }
  }

  restoreClaim(id: string) {
    this.db.query(`
      UPDATE server_bootstrap_drafts SET status = 'issued', claimed_at = NULL
      WHERE id = ? AND status = 'claimed'
    `).run(id)
  }

  artifact(token: string) {
    return this.db
      .query<DraftRow, [string, string]>(`
        SELECT * FROM server_bootstrap_drafts
        WHERE artifact_hash = ? AND artifact_expires_at > ?
          AND status IN ('claimed', 'installed')
      `)
      .get(hashToken(token), new Date().toISOString())
  }

  report(token: string, status: 'installed' | 'failed', error?: string) {
    const row = this.db
      .query<DraftRow, [string]>('SELECT * FROM server_bootstrap_drafts WHERE report_hash = ?')
      .get(hashToken(token))
    if (!row) return null
    this.db.query(`
      UPDATE server_bootstrap_drafts SET
        status = ?, error = ?, installed_at = ?, report_hash = NULL
      WHERE id = ?
    `).run(
      status,
      error?.slice(0, 2000) ?? null,
      status === 'installed' ? new Date().toISOString() : null,
      row.id,
    )
    return this.get(row.id)
  }

  private row(id: string) {
    return this.db
      .query<DraftRow, [string]>('SELECT * FROM server_bootstrap_drafts WHERE id = ?')
      .get(id)
  }
}
