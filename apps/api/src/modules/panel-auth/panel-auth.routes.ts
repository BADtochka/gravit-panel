import { Elysia } from 'elysia'
import {
  PanelAccessDeniedError,
  type PanelAuthService,
  parseCookie,
  serializeCookie,
} from './panel-auth.service'
import { playerSessionForRequest } from '../public-portal/public-portal.routes'

const sessionCookie = 'gravit_panel_session'
const stateCookie = 'gravit_panel_oauth_state'
const returnToCookie = 'gravit_panel_oauth_return_to'
const defaultAdminPath = '/status'
const adminPaths = new Set([
  '/setup',
  '/status',
  '/jobs',
  '/modules',
  '/auth',
  '/users',
  '/launcher',
  '/clients',
  '/mods',
  '/servers',
  '/public-settings',
])

const redirect = (location: string, cookies: string[] = []) => {
  const headers = new Headers({ location })
  for (const cookie of cookies) headers.append('set-cookie', cookie)
  return new Response(null, { status: 302, headers })
}

const safeReturnTo = (value: unknown) => {
  if (typeof value !== 'string' || !value.startsWith('/') || value.startsWith('//')) {
    return defaultAdminPath
  }
  try {
    const url = new URL(value, 'https://panel.invalid')
    if (url.origin !== 'https://panel.invalid' || !adminPaths.has(url.pathname) || url.hash) {
      return defaultAdminPath
    }
    url.searchParams.delete('authError')
    return `${url.pathname}${url.search}`
  } catch {
    return defaultAdminPath
  }
}

const panelLocation = (service: PanelAuthService, request: Request, returnTo: string) =>
  `${service.publicUrl ?? new URL(request.url).origin}${safeReturnTo(returnTo)}`

const withAuthError = (returnTo: string, error: string) => {
  const url = new URL(safeReturnTo(returnTo), 'https://panel.invalid')
  url.searchParams.set('authError', error)
  return `${url.pathname}${url.search}`
}

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
    .get('/login', ({ query, request }) => {
      const returnTo = safeReturnTo(query.returnTo)
      if (!service.enabled) return redirect(panelLocation(service, request, returnTo))
      if (!service.configured) {
        return redirect(panelLocation(service, request, withAuthError(returnTo, 'configuration')))
      }
      const { state } = service.createState()
      return redirect(service.authorizationUrl(state), [
        serializeCookie(stateCookie, state, {
          maxAgeSeconds: 10 * 60,
          secure: service.secureCookies,
          path: service.authCookiePath,
        }),
        serializeCookie(returnToCookie, returnTo, {
          maxAgeSeconds: 10 * 60,
          secure: service.secureCookies,
          path: service.authCookiePath,
        }),
      ])
    })
    .get('/callback', async ({ query, request }) => {
      const returnTo = safeReturnTo(
        parseCookie(request.headers.get('cookie'), returnToCookie),
      )
      const clearState = serializeCookie(stateCookie, '', {
        maxAgeSeconds: 0,
        secure: service.secureCookies,
        path: service.authCookiePath,
      })
      const clearReturnTo = serializeCookie(returnToCookie, '', {
        maxAgeSeconds: 0,
        secure: service.secureCookies,
        path: service.authCookiePath,
      })
      const stateFromCookie = parseCookie(request.headers.get('cookie'), stateCookie)
      if (!query.code || !query.state || !stateFromCookie || query.state !== stateFromCookie) {
        return redirect(panelLocation(service, request, withAuthError(returnTo, 'state')), [
          clearState,
          clearReturnTo,
        ])
      }
      if (!service.consumeState(query.state)) {
        return redirect(panelLocation(service, request, withAuthError(returnTo, 'state')), [
          clearState,
          clearReturnTo,
        ])
      }
      try {
        const login = await service.completeLogin(query.code)
        return redirect(panelLocation(service, request, returnTo), [
          clearState,
          clearReturnTo,
          serializeCookie(sessionCookie, login.session, {
            maxAgeSeconds: 7 * 24 * 60 * 60,
            secure: service.secureCookies,
            path: service.publicPath,
          }),
        ])
      } catch (error) {
        const authError = error instanceof PanelAccessDeniedError ? 'not-authorized' : 'discord'
        return redirect(panelLocation(service, request, withAuthError(returnTo, authError)), [
          clearState,
          clearReturnTo,
        ])
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
    const publicPaths = new Set(['/api/health', '/api/docker/launchserver', '/api/clients/launcher/artifacts'])
  return ({ request }: { request: Request }) => {
    if (!service.enabled) return
    const path = new URL(request.url).pathname
    if (
      publicPaths.has(path) ||
      path.startsWith('/api/panel-auth/') ||
      (path.startsWith('/api/public/') && !path.startsWith('/api/public/settings')) ||
      /^\/api\/server-bootstrap\/[A-Za-z0-9_-]{32,128}(?:\/start|\/report|\/artifacts\/(?:bundle|jre-x64|jre-aarch64))?$/.test(path) ||
      /^\/api\/server-agent\/(?:connect|update|report|archive\/[0-9a-f-]{36})$/.test(path)
    ) return
    if (
      /^\/api\/clients\/launcher\/artifacts\/(?:jar|windows-x64)$/.test(path) &&
      playerSessionForRequest(request)
    ) return
    const session = service.session(parseCookie(request.headers.get('cookie'), sessionCookie))
    if (session) return
    return Response.json({ message: 'Discord authentication is required.' }, { status: 401 })
  }
}
