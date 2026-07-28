import { dirname, join, resolve } from 'node:path'

const databasePath = Bun.env.DATABASE_PATH ?? './data/gravit-panel.sqlite'
const panelAuthMode = Bun.env.PANEL_AUTH_MODE ?? 'disabled'

export const env = {
  HOST: Bun.env.HOST ?? '127.0.0.1',
  PORT: Number(Bun.env.PORT ?? 3000),
  DATABASE_PATH: databasePath,
  INSTALLATIONS_ROOT: Bun.env.INSTALLATIONS_ROOT ?? './data/installations',
  CREDENTIAL_ENCRYPTION_KEY: Bun.env.CREDENTIAL_ENCRYPTION_KEY,
  REMOTE_CONTROL_ENDPOINT: Bun.env.REMOTE_CONTROL_ENDPOINT ?? 'http://127.0.0.1:17549',
  LAUNCHSERVER_PUBLIC_ADDRESS:
    Bun.env.LAUNCHSERVER_PUBLIC_ADDRESS ?? 'localhost:9274',
  CREDENTIAL_ENCRYPTION_KEY_PATH:
    Bun.env.CREDENTIAL_ENCRYPTION_KEY_PATH ??
    (databasePath === ':memory:'
      ? null
      : join(dirname(resolve(databasePath)), 'credential-encryption.key')),
  CORS_ORIGINS: (Bun.env.CORS_ORIGINS ?? 'http://127.0.0.1:5173,http://localhost:5173')
    .split(',')
    .map((origin) => origin.trim())
    .filter(Boolean),
  PANEL_AUTH_MODE: panelAuthMode,
  PANEL_PUBLIC_URL: Bun.env.PANEL_PUBLIC_URL,
  PANEL_AUTH_REDIRECT_URI: Bun.env.PANEL_AUTH_REDIRECT_URI,
  PANEL_DISCORD_CLIENT_ID: Bun.env.PANEL_DISCORD_CLIENT_ID,
  PANEL_DISCORD_CLIENT_SECRET: Bun.env.PANEL_DISCORD_CLIENT_SECRET,
  PANEL_DISCORD_ALLOWED_USER_IDS: (Bun.env.PANEL_DISCORD_ALLOWED_USER_IDS ?? '')
    .split(',')
    .map((id) => id.trim())
    .filter(Boolean),
  PANEL_AUTH_COOKIE_SECURE:
    Bun.env.PANEL_AUTH_COOKIE_SECURE === undefined
      ? Bun.env.NODE_ENV === 'production'
      : Bun.env.PANEL_AUTH_COOKIE_SECURE !== 'false',
}
