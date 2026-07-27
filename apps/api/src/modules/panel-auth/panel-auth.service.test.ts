import { beforeEach, describe, expect, test } from 'bun:test'
import { Database } from 'bun:sqlite'
import { schema } from '../../db/schema'
import {
  PanelAccessDeniedError,
  PanelAuthService,
  parseCookie,
  serializeCookie,
} from './panel-auth.service'

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
})
