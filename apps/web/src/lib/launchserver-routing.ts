export const resolveLaunchServerRedirect = (
  currentPath: string,
  hasLaunchServer: boolean,
) => {
  if (!hasLaunchServer) return currentPath === '/setup' ? '/' : null
  return null
}
