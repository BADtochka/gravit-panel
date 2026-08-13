import { dirname, join, resolve } from 'node:path'

const databasePath = Bun.env.DATABASE_PATH ?? './data/gravit-panel.sqlite'
const panelAuthMode = Bun.env.PANEL_AUTH_MODE ?? 'disabled'
const positiveInteger = (name: string, fallback: number) => {
  const value = Number(Bun.env[name] ?? fallback)
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive integer`)
  }
  return value
}

export const env = {
  HOST: Bun.env.HOST ?? '127.0.0.1',
  PORT: Number(Bun.env.PORT ?? 3000),
  DATABASE_PATH: databasePath,
  INSTALLATIONS_ROOT: Bun.env.INSTALLATIONS_ROOT ?? './data/installations',
  MODULE_ARTIFACTS_DIR: Bun.env.MODULE_ARTIFACTS_DIR ?? './data/modules',
  SERVER_AGENT_ARTIFACTS_DIR:
    Bun.env.SERVER_AGENT_ARTIFACTS_DIR ?? '/opt/gravit-panel/server-agent',
  CREDENTIAL_ENCRYPTION_KEY: Bun.env.CREDENTIAL_ENCRYPTION_KEY,
  REMOTE_CONTROL_ENDPOINT: Bun.env.REMOTE_CONTROL_ENDPOINT ?? 'http://127.0.0.1:17549',
  LAUNCHSERVER_PUBLIC_ADDRESS:
    Bun.env.LAUNCHSERVER_PUBLIC_ADDRESS ?? 'localhost:9274',
  LAUNCHSERVER_PUBLIC_URL:
    Bun.env.LAUNCHSERVER_PUBLIC_URL ||
    `http://${Bun.env.LAUNCHSERVER_PUBLIC_ADDRESS ?? 'localhost:9274'}`,
  PUBLIC_PORTAL_HMAC_SECRET: Bun.env.PUBLIC_PORTAL_HMAC_SECRET,
  CREDENTIAL_ENCRYPTION_KEY_PATH:
    Bun.env.CREDENTIAL_ENCRYPTION_KEY_PATH ??
    (databasePath === ':memory:'
      ? null
      : join(dirname(resolve(databasePath)), 'credential-encryption.key')),
  CORS_ORIGINS: (Bun.env.CORS_ORIGINS || 'http://127.0.0.1:5173,http://localhost:5173')
    .split(',')
    .map((origin) => origin.trim())
    .filter(Boolean),
  PANEL_AUTH_MODE: panelAuthMode,
  PANEL_PUBLIC_URL: Bun.env.PANEL_PUBLIC_URL || undefined,
  PANEL_AUTH_REDIRECT_URI: Bun.env.PANEL_AUTH_REDIRECT_URI || undefined,
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
  PANEL_REVISION: Bun.env.PANEL_REVISION,
  PANEL_UPDATE_REPOSITORY: Bun.env.PANEL_UPDATE_REPOSITORY ?? 'BADtochka/gravit-panel',
  PANEL_UPDATE_GITHUB_TOKEN: Bun.env.PANEL_UPDATE_GITHUB_TOKEN,
  COOLIFY_API_URL: Bun.env.COOLIFY_API_URL,
  COOLIFY_API_TOKEN: Bun.env.COOLIFY_API_TOKEN,
  COOLIFY_APPLICATION_UUID: Bun.env.COOLIFY_APPLICATION_UUID,
  SERVER_PACK_MAX_FILE_BYTES: positiveInteger(
    'SERVER_PACK_MAX_FILE_BYTES',
    256 * 1024 * 1024,
  ),
  SERVER_PACK_MAX_BYTES: positiveInteger(
    'SERVER_PACK_MAX_BYTES',
    4 * 1024 * 1024 * 1024,
  ),
}
