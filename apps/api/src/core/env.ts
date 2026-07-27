import { dirname, join, resolve } from 'node:path'

const databasePath = Bun.env.DATABASE_PATH ?? './data/gravit-panel.sqlite'

export const env = {
  HOST: Bun.env.HOST ?? '127.0.0.1',
  PORT: Number(Bun.env.PORT ?? 3000),
  DATABASE_PATH: databasePath,
  INSTALLATIONS_ROOT: Bun.env.INSTALLATIONS_ROOT ?? './data/installations',
  CREDENTIAL_ENCRYPTION_KEY: Bun.env.CREDENTIAL_ENCRYPTION_KEY,
  CREDENTIAL_ENCRYPTION_KEY_PATH:
    Bun.env.CREDENTIAL_ENCRYPTION_KEY_PATH ??
    (databasePath === ':memory:'
      ? null
      : join(dirname(resolve(databasePath)), 'credential-encryption.key')),
  CORS_ORIGINS: (Bun.env.CORS_ORIGINS ?? 'http://127.0.0.1:5173,http://localhost:5173')
    .split(',')
    .map((origin) => origin.trim())
    .filter(Boolean),
}
