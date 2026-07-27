import { Elysia } from 'elysia'
import {
  PanelAccessDeniedError,
  type PanelAuthService,
  parseCookie,
  serializeCookie,
} from './panel-auth.service'

const sessionCookie = 'gravit_panel_session'
const stateCookie = 'gravit_panel_oauth_state'

const redirect = (location: string, cookies: string[] = []) => {
  const headers = new Headers({ location })
  for (const cookie of cookies) headers.append('set-cookie', cookie)
  return new Response(null, { status: 302, headers })
}

const panelRoot = (service: PanelAuthService, request: Request, suffix = '') =>
  `${service.publicUrl ?? new URL(request.url).origin}/${suffix}`

export const createPanelAuthRoutes = (service: PanelAuthService) =>
  new Elysia({ prefix: '/panel-auth' })
    .get('/session', ({ request }) => {
      const session = service.session(parseCookie(request.headers.get('cookie'), sessionCookie))
      return {
        ...service.status,
        authenticated: Boolean(session),
        user: session
          ? {
              discordId: session.discordId,
              username: session.username,
              globalName: session.globalName,
              avatarHash: session.avatarHash,
            }
          : null,
      }
    })
    .get('/login', ({ request }) => {
      if (!service.enabled) return redirect(panelRoot(service, request))
      if (!service.configured) {
        return redirect(panelRoot(service, request, '?authError=configuration'))
      }
      const { state } = service.createState()
      return redirect(service.authorizationUrl(state), [
        serializeCookie(stateCookie, state, {
          maxAgeSeconds: 10 * 60,
          secure: service.secureCookies,
          path: service.authCookiePath,
        }),
      ])
    })
    .get('/callback', async ({ query, request }) => {
      const clearState = serializeCookie(stateCookie, '', {
        maxAgeSeconds: 0,
        secure: service.secureCookies,
        path: service.authCookiePath,
      })
      const stateFromCookie = parseCookie(request.headers.get('cookie'), stateCookie)
      if (!query.code || !query.state || !stateFromCookie || query.state !== stateFromCookie) {
        return redirect(panelRoot(service, request, '?authError=state'), [clearState])
      }
      if (!service.consumeState(query.state)) {
        return redirect(panelRoot(service, request, '?authError=state'), [clearState])
      }
      try {
        const login = await service.completeLogin(query.code)
        return redirect(panelRoot(service, request), [
          clearState,
          serializeCookie(sessionCookie, login.session, {
            maxAgeSeconds: 7 * 24 * 60 * 60,
            secure: service.secureCookies,
            path: service.publicPath,
          }),
        ])
      } catch (error) {
        const authError = error instanceof PanelAccessDeniedError ? 'not-authorized' : 'discord'
        return redirect(panelRoot(service, request, `?authError=${authError}`), [clearState])
      }
    })
    .post('/logout', ({ request }) => {
      service.revokeSession(parseCookie(request.headers.get('cookie'), sessionCookie))
      return new Response(null, {
        status: 204,
        headers: {
          'set-cookie': serializeCookie(sessionCookie, '', {
            maxAgeSeconds: 0,
            secure: service.secureCookies,
            path: service.publicPath,
          }),
        },
      })
    })

export const createPanelAuthGuard = (service: PanelAuthService) => {
  const publicPaths = new Set(['/api/health'])
  return ({ request }: { request: Request }) => {
    if (!service.enabled) return
    const path = new URL(request.url).pathname
    if (publicPaths.has(path) || path.startsWith('/api/panel-auth/')) return
    const session = service.session(parseCookie(request.headers.get('cookie'), sessionCookie))
    if (session) return
    return Response.json({ message: 'Discord authentication is required.' }, { status: 401 })
  }
}
