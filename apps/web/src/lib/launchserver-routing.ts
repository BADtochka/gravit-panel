export const resolveLaunchServerRedirect = (
  currentPath: string,
  hasLaunchServer: boolean,
) => {
  if (!hasLaunchServer && currentPath.startsWith('/panel') && currentPath !== '/panel/setup') {
    return '/panel/setup'
  }
  if (hasLaunchServer && currentPath === '/panel/setup') return '/panel/status'
  return null
}
