import type { Database } from 'bun:sqlite'
import type { CredentialCipher } from '../../core/credential-cipher'

interface RemoteControlCredentialRow {
  installation_id: string
  endpoint: string
  token_ciphertext: string
  token_iv: string
  token_auth_tag: string
  source_revision: string
  configured_at: string
}

export interface RemoteControlCredential {
  installationId: string
  endpoint: string
  token: string
  sourceRevision: string
  configuredAt: string
}

export class RemoteControlStore {
  constructor(
    private readonly db: Database,
    private readonly cipher: CredentialCipher,
  ) {}

  save(installationId: string, endpoint: string, token: string, sourceRevision: string) {
    const encrypted = this.cipher.encrypt(token)
    const configuredAt = new Date().toISOString()
    this.db
      .query(`
        INSERT INTO remote_control_credentials (
          installation_id, endpoint, token_ciphertext, token_iv,
          token_auth_tag, source_revision, configured_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(installation_id) DO UPDATE SET
          endpoint = excluded.endpoint,
          token_ciphertext = excluded.token_ciphertext,
          token_iv = excluded.token_iv,
          token_auth_tag = excluded.token_auth_tag,
          source_revision = excluded.source_revision,
          configured_at = excluded.configured_at
      `)
      .run(
        installationId,
        endpoint,
        encrypted.ciphertext,
        encrypted.iv,
        encrypted.authTag,
        sourceRevision,
        configuredAt,
      )
  }

  get(installationId: string): RemoteControlCredential | null {
    const row = this.db
      .query<RemoteControlCredentialRow, [string]>(
        'SELECT * FROM remote_control_credentials WHERE installation_id = ?',
      )
      .get(installationId)
    if (!row) return null

    return {
      installationId: row.installation_id,
      endpoint: row.endpoint,
      token: this.cipher.decrypt({
        ciphertext: row.token_ciphertext,
        iv: row.token_iv,
        authTag: row.token_auth_tag,
      }),
      sourceRevision: row.source_revision,
      configuredAt: row.configured_at,
    }
  }

  listConfiguredInstallationIds(): string[] {
    return this.db
      .query<{ installation_id: string }, []>(
        'SELECT installation_id FROM remote_control_credentials ORDER BY configured_at DESC',
      )
      .all()
      .map((row) => row.installation_id)
  }

  hasEncryptedCredentials() {
    const row = this.db
      .query<{ count: number }, []>('SELECT COUNT(*) AS count FROM remote_control_credentials')
      .get()
    return Boolean(row?.count)
  }

  delete(installationId: string) {
    this.db
      .query('DELETE FROM remote_control_credentials WHERE installation_id = ?')
      .run(installationId)
  }
}
