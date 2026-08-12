import { Database } from 'bun:sqlite'
import { describe, expect, test } from 'bun:test'
import { schema } from '../../db/schema'
import { createPanelAuthRoutes } from './panel-auth.routes'
import { PanelAuthService } from './panel-auth.service'

const createHarness = () => {
  const database = new Database(':memory:')
  database.exec(schema)
  const service = new PanelAuthService(database, {
    mode: 'discord',
    publicUrl: 'https://panel.example.com/panel',
    discordClientId: 'client-id',
    discordClientSecret: 'client-secret',
    allowedDiscordUserIds: ['123'],
    secureCookies: true,
  }, async (input) => {
    if (String(input) === 'https://discord.com/api/oauth2/token') {
      return Response.json({ access_token: 'discord-token' })
    }
    return Response.json({ id: '123', username: 'admin' })
  })
  return createPanelAuthRoutes(service)
}

const cookieHeader = (response: Response) => response.headers
  .getSetCookie()
  .map((cookie) => cookie.split(';', 1)[0])
  .join('; ')

describe('panel auth redirects', () => {
  test('returns an authenticated user to the requested admin route', async () => {
    const app = createHarness()
    const login = await app.handle(new Request(
      'https://internal/panel-auth/login?returnTo=%2Fpanel%2Fservers%3Fserver%3Dabc',
    ))
    const authorizationUrl = new URL(login.headers.get('location')!)
    const state = authorizationUrl.searchParams.get('state')!

    const callback = await app.handle(new Request(
      `https://internal/panel-auth/callback?code=code&state=${encodeURIComponent(state)}`,
      { headers: { cookie: cookieHeader(login) } },
    ))

    expect(callback.status).toBe(302)
    expect(callback.headers.get('location')).toBe(
      'https://panel.example.com/panel/servers?server=abc',
    )
  })

  test('rejects public and external return targets', async () => {
    for (const returnTo of ['/account', '//evil.example/path', 'https://evil.example/path']) {
      const app = createHarness()
      const login = await app.handle(new Request(
        `https://internal/panel-auth/login?returnTo=${encodeURIComponent(returnTo)}`,
      ))
      const authorizationUrl = new URL(login.headers.get('location')!)
      const state = authorizationUrl.searchParams.get('state')!
      const callback = await app.handle(new Request(
        `https://internal/panel-auth/callback?code=code&state=${encodeURIComponent(state)}`,
        { headers: { cookie: cookieHeader(login) } },
      ))

      expect(callback.headers.get('location')).toBe('https://panel.example.com/panel/status')
    }
  })
})
