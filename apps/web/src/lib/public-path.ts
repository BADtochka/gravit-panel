interface PanelRuntimeConfiguration {
  publicPath?: string
}

type PanelFetch = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>

declare global {
  interface Window {
    __GRAVIT_PANEL_CONFIG__?: PanelRuntimeConfiguration
  }
}

const normalizePublicPath = (value: unknown) => {
  if (typeof value !== 'string' || value === '/' || value === '') return ''
  if (!value.startsWith('/') || value.includes('//') || value.includes('..')) return ''
  return value.replace(/\/+$/, '')
}

export const panelPublicPath = normalizePublicPath(
  typeof window === 'undefined' ? undefined : window.__GRAVIT_PANEL_CONFIG__?.publicPath,
)

export const panelUrl = (path: string) => {
  if (!path.startsWith('/') || path.startsWith('//') || /^[a-z][a-z\d+.-]*:/i.test(path)) {
    return path
  }
  if (panelPublicPath && (path === panelPublicPath || path.startsWith(`${panelPublicPath}/`))) {
    return path
  }
  return `${panelPublicPath}${path}` || '/'
}

export const panelFetch: PanelFetch = (input, init) => {
  if (typeof input === 'string') return fetch(panelUrl(input), init)
  if (input instanceof URL) return fetch(panelUrl(input.toString()), init)
  return fetch(input, init)
}

let fetchRoutingInstalled = false

export const installPanelFetchRouting = () => {
  if (typeof window === 'undefined') return
  if (fetchRoutingInstalled) return
  const nativeFetch = window.fetch.bind(window)
  window.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    if (typeof input === 'string') return nativeFetch(panelUrl(input), init)
    if (input instanceof URL) return nativeFetch(panelUrl(input.toString()), init)
    return nativeFetch(input, init)
  }) as typeof window.fetch
  fetchRoutingInstalled = true
}
