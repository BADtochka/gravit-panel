import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises'
import { existsSync, readFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { randomBytes } from 'node:crypto'
import type { CredentialCipher } from './credential-cipher'

export type CredentialKeySource = 'environment' | 'generated' | 'memory'

export interface CredentialKeyStatus {
  configured: boolean
  source: CredentialKeySource | null
  canGenerate: boolean
}

export class CredentialKeyService {
  private source: CredentialKeySource | null = null
  private generation: Promise<CredentialKeyStatus> | null = null

  constructor(
    private readonly cipher: CredentialCipher,
    private readonly keyPath: string | null,
    environmentKey?: string,
  ) {
    if (environmentKey) {
      this.cipher.configure(environmentKey)
      this.source = 'environment'
      return
    }

    if (keyPath && existsSync(keyPath)) {
      this.cipher.configure(readFileSync(keyPath, 'utf8').trim())
      this.source = 'generated'
    }
  }

  get status(): CredentialKeyStatus {
    return {
      configured: this.cipher.configured,
      source: this.source,
      canGenerate: !this.cipher.configured,
    }
  }

  generate() {
    if (this.cipher.configured) {
      throw new Error('Credential encryption is already configured')
    }
    if (!this.generation) {
      this.generation = this.generateKey().finally(() => {
        this.generation = null
      })
    }
    return this.generation
  }

  private async generateKey(): Promise<CredentialKeyStatus> {
    const encodedKey = randomBytes(32).toString('base64')

    if (!this.keyPath) {
      this.cipher.configure(encodedKey)
      this.source = 'memory'
      return this.status
    }

    await mkdir(dirname(this.keyPath), { recursive: true })
    try {
      await writeFile(this.keyPath, `${encodedKey}\n`, {
        encoding: 'utf8',
        flag: 'wx',
        mode: 0o600,
      })
      await chmod(this.keyPath, 0o600)
    } catch (error) {
      if (error instanceof Error && 'code' in error && error.code === 'EEXIST') {
        const existingKey = (await readFile(this.keyPath, 'utf8')).trim()
        this.cipher.configure(existingKey)
        this.source = 'generated'
        return this.status
      }
      throw error
    }

    this.cipher.configure(encodedKey)
    this.source = 'generated'
    return this.status
  }
}
