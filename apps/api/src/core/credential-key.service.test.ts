import { describe, expect, test } from 'bun:test'
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomBytes } from 'node:crypto'
import { CredentialCipher } from './credential-cipher'
import { CredentialKeyService } from './credential-key.service'

describe('CredentialKeyService', () => {
  test('generates a persisted 0600 key and restores it after restart', async () => {
    const temporaryRoot = await mkdtemp(join(tmpdir(), 'gravit-credential-key-'))
    const keyPath = join(temporaryRoot, 'credential-encryption.key')
    const firstCipher = new CredentialCipher()
    const firstService = new CredentialKeyService(firstCipher, keyPath)

    try {
      expect(firstService.status).toEqual({
        configured: false,
        source: null,
        canGenerate: true,
      })

      const status = await firstService.generate()
      const encrypted = firstCipher.encrypt('secret-token')

      expect(status).toEqual({
        configured: true,
        source: 'generated',
        canGenerate: false,
      })
      expect((await stat(keyPath)).mode & 0o777).toBe(0o600)
      expect(Buffer.from((await readFile(keyPath, 'utf8')).trim(), 'base64')).toHaveLength(32)

      const restoredCipher = new CredentialCipher()
      const restoredService = new CredentialKeyService(restoredCipher, keyPath)
      expect(restoredService.status.source).toBe('generated')
      expect(restoredCipher.decrypt(encrypted)).toBe('secret-token')
    } finally {
      await rm(temporaryRoot, { recursive: true, force: true })
    }
  })

  test('keeps an operator-provided environment key authoritative', async () => {
    const encodedKey = randomBytes(32).toString('base64')
    const cipher = new CredentialCipher()
    const service = new CredentialKeyService(cipher, null, encodedKey)

    expect(service.status).toEqual({
      configured: true,
      source: 'environment',
      canGenerate: false,
    })
    expect(() => service.generate()).toThrow('already configured')
  })
})
