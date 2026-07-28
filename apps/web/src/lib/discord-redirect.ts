const localAddress = /^(?:localhost|127(?:\.\d{1,3}){3}|\[::1\])(?::\d+)?(?:\/|$)/i

export const defaultDiscordRedirectUrl = (address: string | null | undefined) => {
  const value = address?.trim()
  if (!value) return ''

  try {
    const url = new URL(/^[a-z][a-z\d+.-]*:\/\//i.test(value)
      ? value
      : `${localAddress.test(value) ? 'http' : 'https'}://${value}`)
    url.pathname = `${url.pathname.replace(/\/+$/, '')}/webapi/auth/discord`
    url.search = ''
    url.hash = ''
    return url.toString()
  } catch {
    return ''
  }
}
