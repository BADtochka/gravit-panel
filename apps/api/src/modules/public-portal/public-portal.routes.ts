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
  .get('/auth/login', ({ request }) => {
    const base = env.LAUNCHSERVER_PUBLIC_URL.replace(/\/+$/, '')
    try {
      const url = new URL(`${base}/webapi/auth/discord/portal`)
      return Response.redirect(url, 302)
    } catch {
      return Response.json({ message: 'The Discord portal endpoint is not configured.' }, { status: 503 })
    }
  })
  .get('/auth/callback', ({ query, request }) => {
    try {
      const completed = portal.completeTicket(query.ticket)
      return new Response(null, {
        status: 302,
        headers: {
          location: `${panelRoot(request).replace(/\/$/, '')}/account?playerAuth=success`,
          'set-cookie': serializeCookie(playerSessionCookie, completed.session, playerCookieOptions),
        },
      })
    } catch (error) {
      return Response.redirect(`${panelRoot(request).replace(/\/$/, '')}/account?playerAuth=error`, 302)
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
  .get('/skins/:filename', ({ params, set }) => {
    const username = params.filename.slice(0, -4)
    const skin = portal.skinForUsername(username)
    if (!skin) { set.status = 404; return { message: 'Skin not found.' } }
    set.headers['content-type'] = 'image/png'
    set.headers['cache-control'] = 'public, max-age=300'
    set.headers.etag = `"${skin.sha256}"`
    return skin.image
  }, { params: t.Object({ filename: t.String({ minLength: 6, maxLength: 20, pattern: '^[A-Za-z0-9_]{2,16}\\.png$' }) }) })
