export const launchServerCommands = [
  'version',
  'build',
  'modules list',
  'modules available',
  'modules load',
  'modules launcher-load',
  'profile list',
  'profile create',
  'serverStatus',
  'securitycheck',
  'config profileprovider sync',
] as const

export type LaunchServerCommand = (typeof launchServerCommands)[number]
