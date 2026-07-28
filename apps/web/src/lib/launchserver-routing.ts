export const resolveLaunchServerRedirect = (
  currentPath: string,
  hasLaunchServer: boolean,
) => {
  if (!hasLaunchServer) return currentPath === '/' ? null : '/'
  if (currentPath === '/') return '/status'
  return null
}
