import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'

export interface EncryptedValue {
  ciphertext: string
  iv: string
  authTag: string
}

export class CredentialCipher {
  private key: Buffer | null = null

  constructor(encodedKey?: string) {
    if (encodedKey) this.configure(encodedKey)
  }

  configure(encodedKey: string) {
    if (!/^[a-zA-Z0-9+/]+={0,2}$/.test(encodedKey)) {
      throw new Error('CREDENTIAL_ENCRYPTION_KEY must be a base64-encoded 32-byte key')
    }
    const key = Buffer.from(encodedKey, 'base64')
    if (key.byteLength !== 32) {
      throw new Error('CREDENTIAL_ENCRYPTION_KEY must decode to exactly 32 bytes')
    }
    this.key = key
  }

  get configured() {
    return this.key !== null
  }

  encrypt(value: string): EncryptedValue {
    if (!this.key) throw new Error('Credential encryption is not configured')

    const iv = randomBytes(12)
    const cipher = createCipheriv('aes-256-gcm', this.key, iv)
    const ciphertext = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()])
    return {
      ciphertext: ciphertext.toString('base64'),
      iv: iv.toString('base64'),
      authTag: cipher.getAuthTag().toString('base64'),
    }
  }

  decrypt(value: EncryptedValue): string {
    if (!this.key) throw new Error('Credential encryption is not configured')

    const decipher = createDecipheriv('aes-256-gcm', this.key, Buffer.from(value.iv, 'base64'))
    decipher.setAuthTag(Buffer.from(value.authTag, 'base64'))
    return Buffer.concat([
      decipher.update(Buffer.from(value.ciphertext, 'base64')),
      decipher.final(),
    ]).toString('utf8')
  }
}
