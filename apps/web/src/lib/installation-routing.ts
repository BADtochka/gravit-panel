export const resolveInstallationRedirect = (
  currentPath: string,
  installationCount: number,
) => {
  if (installationCount === 0) return currentPath === '/' ? null : '/'
  if (currentPath === '/') return '/status'
  return null
}
