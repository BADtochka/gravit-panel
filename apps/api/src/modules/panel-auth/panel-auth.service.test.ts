import { beforeEach, describe, expect, test } from 'bun:test'
import { Database } from 'bun:sqlite'
import { schema } from '../../db/schema'
import {
  PanelAccessDeniedError,
  PanelAuthService,
  parseCookie,
  serializeCookie,
} from './panel-auth.service'
import { createPanelAuthGuard } from './panel-auth.routes'

const configuration = {
  mode: 'discord',
  redirectUri: 'https://panel.example.com/api/panel-auth/callback',
  discordClientId: 'client-id',
  discordClientSecret: 'client-secret',
  allowedDiscordUserIds: ['123'],
  secureCookies: true,
}

describe('PanelAuthService', () => {
  let database: Database

  beforeEach(() => {
    database = new Database(':memory:')
    database.exec(schema)
  })

  test('creates a one-time OAuth state and authorization URL', () => {
    const service = new PanelAuthService(database, configuration)
    const { state } = service.createState()
    const url = new URL(service.authorizationUrl(state))

    expect(url.origin).toBe('https://discord.com')
    expect(url.searchParams.get('scope')).toBe('identify')
    expect(url.searchParams.get('redirect_uri')).toBe('https://panel.example.com/api/panel-auth/callback')
    expect(url.searchParams.get('state')).toBe(state)
    expect(service.consumeState(state)).toBe(true)
    expect(service.consumeState(state)).toBe(false)
  })

  test('creates a session only for an allowed Discord account', async () => {
    const fetcher = async (input: RequestInfo | URL) => {
      if (input === 'https://discord.com/api/oauth2/token') {
        return Response.json({ access_token: 'discord-token' })
      }
      return Response.json({ id: '123', username: 'bad', global_name: 'Bad', avatar: null })
    }
    const service = new PanelAuthService(database, configuration, fetcher)
    const login = await service.completeLogin('authorization-code')

    expect(login.user).toEqual({
      discordId: '123',
      username: 'bad',
      globalName: 'Bad',
      avatarHash: null,
    })
    expect(service.session(login.session)).toMatchObject({ discordId: '123', username: 'bad' })
    service.revokeSession(login.session)
    expect(service.session(login.session)).toBeNull()
  })

  test('rejects Discord accounts outside the allowlist', async () => {
    const fetcher = async (input: RequestInfo | URL) => {
      if (input === 'https://discord.com/api/oauth2/token') {
        return Response.json({ access_token: 'discord-token' })
      }
      return Response.json({ id: '456', username: 'unknown' })
    }
    const service = new PanelAuthService(database, configuration, fetcher)

    await expect(service.completeLogin('authorization-code')).rejects.toBeInstanceOf(
      PanelAccessDeniedError,
    )
  })

  test('uses secure, HttpOnly cookie defaults', () => {
    const cookie = serializeCookie('session', 'opaque-value', {
      maxAgeSeconds: 60,
      secure: true,
    })
    expect(cookie).toContain('HttpOnly')
    expect(cookie).toContain('SameSite=Lax')
    expect(cookie).toContain('Secure')
    expect(parseCookie(cookie, 'session')).toBe('opaque-value')
  })

  test('keeps redirects and cookies within a configured public subroute', () => {
    const service = new PanelAuthService(database, {
      ...configuration,
      publicUrl: 'https://panel.example.com/panel/',
      redirectUri: 'https://ignored.example.test/callback',
    })

    expect(service.publicUrl).toBe('https://panel.example.com/panel')
    expect(service.publicPath).toBe('/panel')
    expect(service.redirectUri).toBe('https://panel.example.com/panel/api/panel-auth/callback')
    expect(service.authCookiePath).toBe('/panel/api/panel-auth')
  })

  test('allows token-authenticated bootstrap and server agent routes without a panel session', () => {
    const service = new PanelAuthService(database, configuration)
    const guard = createPanelAuthGuard(service)
    const claim = 'a'.repeat(43)
    const publicPaths = [
      `/api/server-bootstrap/${claim}`,
      `/api/server-bootstrap/${claim}/start`,
      `/api/server-bootstrap/${claim}/artifacts/bundle`,
      `/api/server-bootstrap/${claim}/report`,
      '/api/server-agent/update',
      '/api/server-agent/report',
      '/api/server-agent/archive/66b1003b-0454-4581-9423-91a62c2f197f',
    ]

    for (const path of publicPaths) {
      expect(guard({ request: new Request(`https://panel.example.com${path}`) })).toBeUndefined()
    }
    const protectedResult = guard({
      request: new Request('https://panel.example.com/api/servers'),
    })
    expect(protectedResult).toBeInstanceOf(Response)
    expect((protectedResult as Response).status).toBe(401)
  })
})
