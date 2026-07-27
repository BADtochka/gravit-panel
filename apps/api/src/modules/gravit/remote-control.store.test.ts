import { describe, expect, test } from 'bun:test'
import { Database } from 'bun:sqlite'
import { randomBytes } from 'node:crypto'
import { CredentialCipher } from '../../core/credential-cipher'
import { schema } from '../../db/schema'
import { InstallationsStore } from './installations.store'
import { RemoteControlStore } from './remote-control.store'

describe('RemoteControlStore', () => {
  test('never persists the plaintext token', () => {
    const database = new Database(':memory:')
    database.exec(schema)
    const installations = new InstallationsStore(database)
    const installation = installations.upsert('test', {
      installationPath: '/srv/test',
      mode: 'clone',
      address: 'localhost:17549',
      projectName: 'TEST',
      sourceRepository: 'https://github.com/GravitLauncher/LauncherDockered',
      sourceRevision: '723203b56f8d58f2447edd20ac8a5b84a31ef816',
      environmentBackupPath: null,
    })
    const store = new RemoteControlStore(
      database,
      new CredentialCipher(randomBytes(32).toString('base64')),
    )

    store.save(installation.id, 'http://localhost:17549', 'plaintext-token', 'source-revision')

    const raw = database
      .query<{ token_ciphertext: string }, []>(
        'SELECT token_ciphertext FROM remote_control_credentials',
      )
      .get()
    expect(raw?.token_ciphertext).not.toContain('plaintext-token')
    expect(store.get(installation.id)).toMatchObject({
      endpoint: 'http://localhost:17549',
      token: 'plaintext-token',
    })
    database.close()
  })
})
