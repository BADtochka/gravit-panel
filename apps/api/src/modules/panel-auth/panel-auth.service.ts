import { createHash, randomBytes } from 'node:crypto'
import type { Database } from 'bun:sqlite'

const discordAuthorizeUrl = 'https://discord.com/oauth2/authorize'
const discordTokenUrl = 'https://discord.com/api/oauth2/token'
const discordUserUrl = 'https://discord.com/api/v10/users/@me'
const stateLifetimeMs = 10 * 60 * 1000
const sessionLifetimeMs = 7 * 24 * 60 * 60 * 1000

export interface PanelAuthConfiguration {
  mode: string
  publicUrl?: string
  redirectUri?: string
  discordClientId?: string
  discordClientSecret?: string
  allowedDiscordUserIds: string[]
  secureCookies: boolean
}

export interface PanelUser {
  discordId: string
  username: string
  globalName: string | null
  avatarHash: string | null
}

interface DiscordTokenResponse {
  access_token?: string
}

interface DiscordUserResponse {
  id?: string
  username?: string
  global_name?: string | null
  avatar?: string | null
}

type Fetcher = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>

interface StoredSession extends PanelUser {
  expiresAt: string
}

export interface PanelAuthState {
  state: string
  expiresAt: string
}

export interface CompletedPanelLogin {
  session: string
  user: PanelUser
  expiresAt: string
}

const hash = (value: string) => createHash('sha256').update(value).digest('hex')
const randomToken = () => randomBytes(32).toString('base64url')
const nowIso = () => new Date().toISOString()

export class PanelAuthService {
  constructor(
    private readonly database: Database,
    private readonly configuration: PanelAuthConfiguration,
    private readonly fetcher: Fetcher = fetch,
    private readonly clock: () => Date = () => new Date(),
  ) {}

  get enabled() {
    return this.configuration.mode === 'discord'
  }

  get configured() {
    return (
      this.enabled &&
      Boolean(this.redirectUri) &&
      Boolean(this.configuration.discordClientId) &&
      Boolean(this.configuration.discordClientSecret) &&
      this.configuration.allowedDiscordUserIds.length > 0
    )
  }

  get secureCookies() {
    return this.configuration.secureCookies
  }

  get publicUrl() {
    const configuredUrl = this.configuration.publicUrl ?? this.inferPublicUrlFromRedirect()
    if (!configuredUrl) return null
    try {
      const url = new URL(configuredUrl)
      if (url.protocol !== 'http:' && url.protocol !== 'https:') return null
      if (url.search || url.hash) return null
      const pathname = url.pathname === '/' ? '' : url.pathname.replace(/\/+$/, '')
      return `${url.origin}${pathname}`
    } catch {
      return null
    }
  }

  get publicPath() {
    if (!this.publicUrl) return '/'
    return new URL(this.publicUrl).pathname || '/'
  }

  get redirectUri() {
    const publicUrl = this.publicUrl
    return publicUrl ? `${publicUrl}/api/panel-auth/callback` : null
  }

  get authCookiePath() {
    return `${this.publicPath === '/' ? '' : this.publicPath}/api/panel-auth`
  }

  get status() {
    return {
      enabled: this.enabled,
      configured: this.configured,
      allowedUserCount: this.configuration.allowedDiscordUserIds.length,
    }
  }

  createState(): PanelAuthState {
    this.requireConfigured()
    this.cleanupExpired()
    const state = randomToken()
    const expiresAt = new Date(this.clock().getTime() + stateLifetimeMs).toISOString()
    this.database
      .query('INSERT INTO panel_oauth_states (state_hash, expires_at) VALUES (?, ?)')
      .run(hash(state), expiresAt)
    return { state, expiresAt }
  }

  consumeState(state: string): boolean {
    this.cleanupExpired()
    const result = this.database
      .query('DELETE FROM panel_oauth_states WHERE state_hash = ?')
      .run(hash(state))
    return result.changes === 1
  }

  authorizationUrl(state: string) {
    this.requireConfigured()
    const url = new URL(discordAuthorizeUrl)
    url.searchParams.set('client_id', this.configuration.discordClientId!)
    url.searchParams.set('redirect_uri', this.redirectUri!)
    url.searchParams.set('response_type', 'code')
    url.searchParams.set('scope', 'identify')
    url.searchParams.set('state', state)
    return url.toString()
  }

  async completeLogin(code: string): Promise<CompletedPanelLogin> {
    this.requireConfigured()
    const form = new URLSearchParams({
      client_id: this.configuration.discordClientId!,
      client_secret: this.configuration.discordClientSecret!,
      grant_type: 'authorization_code',
      code,
      redirect_uri: this.redirectUri!,
    })
    const tokenResponse = await this.fetcher(discordTokenUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: form,
    })
    if (!tokenResponse.ok) throw new Error('Discord rejected the authorization code.')
    const token = (await tokenResponse.json()) as DiscordTokenResponse
    if (!token.access_token) throw new Error('Discord returned no access token.')

    const userResponse = await this.fetcher(discordUserUrl, {
      headers: { authorization: `Bearer ${token.access_token}` },
    })
    if (!userResponse.ok) throw new Error('Discord user lookup failed.')
    const discordUser = (await userResponse.json()) as DiscordUserResponse
    if (!discordUser.id || !discordUser.username) throw new Error('Discord returned an invalid user.')
    if (!this.configuration.allowedDiscordUserIds.includes(discordUser.id)) {
      throw new PanelAccessDeniedError()
    }

    this.cleanupExpired()
    const session = randomToken()
    const expiresAt = new Date(this.clock().getTime() + sessionLifetimeMs).toISOString()
    const user: PanelUser = {
      discordId: discordUser.id,
      username: discordUser.username,
      globalName: discordUser.global_name ?? null,
      avatarHash: discordUser.avatar ?? null,
    }
    this.database
      .query(
        `INSERT INTO panel_sessions (
          session_hash, discord_id, username, global_name, avatar_hash, expires_at, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        hash(session),
        user.discordId,
        user.username,
        user.globalName,
        user.avatarHash,
        expiresAt,
        nowIso(),
      )
    return { session, user, expiresAt }
  }

  session(session: string | undefined): StoredSession | null {
    if (!session) return null
    this.cleanupExpired()
    return (
      this.database
        .query<StoredSession, [string]>(
          `SELECT
            discord_id AS discordId,
            username,
            global_name AS globalName,
            avatar_hash AS avatarHash,
            expires_at AS expiresAt
          FROM panel_sessions
          WHERE session_hash = ?`,
        )
        .get(hash(session)) ?? null
    )
  }

  revokeSession(session: string | undefined) {
    if (!session) return
    this.database.query('DELETE FROM panel_sessions WHERE session_hash = ?').run(hash(session))
  }

  private cleanupExpired() {
    const now = this.clock().toISOString()
    this.database.query('DELETE FROM panel_oauth_states WHERE expires_at <= ?').run(now)
    this.database.query('DELETE FROM panel_sessions WHERE expires_at <= ?').run(now)
  }

  private inferPublicUrlFromRedirect() {
    if (!this.configuration.redirectUri) return null
    try {
      const url = new URL(this.configuration.redirectUri)
      const callbackPath = '/api/panel-auth/callback'
      if (!url.pathname.endsWith(callbackPath)) return url.origin
      const publicPath = url.pathname.slice(0, -callbackPath.length).replace(/\/+$/, '')
      return `${url.origin}${publicPath}`
    } catch {
      return null
    }
  }

  private requireConfigured() {
    if (!this.configured) {
      throw new Error('Discord panel authentication is not configured.')
    }
  }
}

export class PanelAccessDeniedError extends Error {
  constructor() {
    super('This Discord account is not allowed to access the panel.')
  }
}

export const parseCookie = (header: string | null, name: string) => {
  if (!header) return undefined
  const entry = header.split(';').find((part) => part.trim().startsWith(`${name}=`))
  if (!entry) return undefined
  return decodeURIComponent(entry.trim().slice(name.length + 1))
}

export const serializeCookie = (
  name: string,
  value: string,
  options: { maxAgeSeconds: number; secure: boolean; path?: string },
) =>
  [
    `${name}=${encodeURIComponent(value)}`,
    `Path=${options.path ?? '/'}`,
    'HttpOnly',
    'SameSite=Lax',
    `Max-Age=${options.maxAgeSeconds}`,
    ...(options.secure ? ['Secure'] : []),
  ].join('; ')
