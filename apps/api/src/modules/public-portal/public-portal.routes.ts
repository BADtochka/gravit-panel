import { Elysia, t } from 'elysia'
import { env } from '../../core/env'
import { database } from '../../db/client'
import { parseCookie, serializeCookie } from '../panel-auth/panel-auth.service'
import { PublicPortalService } from './public-portal.service'

export const playerSessionCookie = 'gravit_player_session'
const playerCookieOptions = {
  maxAgeSeconds: 7 * 24 * 60 * 60,
  secure: env.PANEL_AUTH_COOKIE_SECURE,
  path: '/',
}
const portal = new PublicPortalService(database, env.PUBLIC_PORTAL_HMAC_SECRET)
export const publicPortalService = portal

const panelRoot = (request: Request) => env.PANEL_PUBLIC_URL ?? new URL(request.url).origin
export const playerSessionForRequest = (request: Request) =>
  portal.session(parseCookie(request.headers.get('cookie'), playerSessionCookie))
const sessionFor = playerSessionForRequest

export const publicPortalRoutes = new Elysia({ prefix: '/public' })
  .get('/page', () => portal.settings())
  .get('/settings', () => portal.settings())
  .put('/settings', ({ body }) => portal.updateSettings(body), {
    body: t.Object({
      title: t.String({ maxLength: 120 }),
      description: t.String({ maxLength: 500 }),
      hiddenLauncherVariants: t.Array(t.Union([t.Literal('jar'), t.Literal('windows-x64')])),
    }),
  })
  .get('/auth/login', ({ request, set }) => {
    const base = env.LAUNCHSERVER_PUBLIC_URL.replace(/\/+$/, '')
    try {
      const url = new URL(`${base}/webapi/auth/discord/portal`)
      set.redirect = url.toString()
      return
    } catch {
      set.status = 503
      return { message: 'The Discord portal endpoint is not configured.' }
    }
  })
  .get('/auth/callback', ({ query, request, set }) => {
    try {
      const completed = portal.completeTicket(query.ticket)
      set.headers['set-cookie'] = serializeCookie(playerSessionCookie, completed.session, playerCookieOptions)
      set.redirect = `${panelRoot(request).replace(/\/$/, '')}/?playerAuth=success`
    } catch (error) {
      set.redirect = `${panelRoot(request).replace(/\/$/, '')}/?playerAuth=error`
    }
  }, { query: t.Object({ ticket: t.String({ minLength: 1, maxLength: 4096 }) }) })
  .get('/session', ({ request }) => ({ player: sessionFor(request) }))
  .post('/logout', ({ request, set }) => {
    portal.revokeSession(parseCookie(request.headers.get('cookie'), playerSessionCookie))
    set.headers['set-cookie'] = serializeCookie(playerSessionCookie, '', { ...playerCookieOptions, maxAgeSeconds: 0 })
    set.status = 204
  })
  .get('/skin', ({ request, set }) => {
    const player = sessionFor(request)
    if (!player) { set.status = 401; return { message: 'Player authentication is required.' } }
    return { item: portal.skinForPlayer(player) }
  })
  .post('/skin', async ({ body, request, set }) => {
    const player = sessionFor(request)
    if (!player) { set.status = 401; return { message: 'Player authentication is required.' } }
    try { return { item: portal.setSkin(player, new Uint8Array(await body.file.arrayBuffer())) } }
    catch (error) { set.status = 400; return { message: error instanceof Error ? error.message : 'Skin upload failed.' } }
  }, { body: t.Object({ file: t.File({ type: 'image/png', maxSize: 1024 * 1024 }) }) })
  .get('/skins/:username.png', ({ params, set }) => {
    const skin = portal.skinForUsername(params.username)
    if (!skin) { set.status = 404; return { message: 'Skin not found.' } }
    set.headers['content-type'] = 'image/png'
    set.headers['cache-control'] = 'public, max-age=300'
    set.headers.etag = `"${skin.sha256}"`
    return skin.image
  }, { params: t.Object({ username: t.String({ minLength: 2, maxLength: 16, pattern: '^[A-Za-z0-9_]+$' }) }) })
