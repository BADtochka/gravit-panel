import { describe, expect, test } from 'bun:test'
import { randomBytes } from 'node:crypto'
import { CredentialCipher } from './credential-cipher'

describe('CredentialCipher', () => {
  test('encrypts and authenticates credentials with AES-256-GCM', () => {
    const cipher = new CredentialCipher(randomBytes(32).toString('base64'))
    const encrypted = cipher.encrypt('secret-token')

    expect(encrypted.ciphertext).not.toContain('secret-token')
    expect(cipher.decrypt(encrypted)).toBe('secret-token')
  })

  test('requires an explicit 32-byte key', () => {
    expect(() => new CredentialCipher('c2hvcnQ=')).toThrow('exactly 32 bytes')
    expect(new CredentialCipher().configured).toBe(false)
  })
})
