import type {
  GravitModuleCatalog,
  GravitModuleCatalogItem,
  GravitModuleCategory,
  GravitModuleItemSource,
  GravitModuleKind,
} from '@gravit-panel/shared'

export const moduleCatalogSource = {
  repository: 'https://github.com/GravitLauncher/LauncherModules',
  revision: 'ebe98aa204c3282430cef4dd5bbb75ac1c7d3e0a',
} as const

export const discordAuthSystemSource = {
  repository: 'https://github.com/BADtochka/gravit-panel',
  revision: 'main',
  path: 'modules/DiscordAuthSystem_module',
} as const

export const discordAuthSystemArtifactVersion = '1.0.8'
export const discordAuthSystemJarName = 'DiscordAuthSystem_module.jar'

export const moduleRelease = {
  repository: 'https://github.com/GravitLauncher/Launcher',
  tag: 'v5.7.9',
  revision: '81132768a711a0eab0e8b3b8b6c480b90f48795c',
  asset: 'LaunchServerBuild.zip',
  downloadUrl:
    'https://github.com/GravitLauncher/Launcher/releases/download/v5.7.9/LaunchServerBuild.zip',
  sha256: 'cfc60bfdf023c1e73031828406e9170b519f17a053c8056a0f0cbce887233f07',
} as const

export const moduleCommandSource = {
  repository: 'https://github.com/GravitLauncher/Launcher',
  revision: moduleRelease.revision,
  files: [
    'components/launchserver/src/main/java/pro/gravit/launchserver/command/modules/ModuleAvailableListCommand.java',
    'components/launchserver/src/main/java/pro/gravit/launchserver/command/modules/ModulesListCommand.java',
    'components/launchserver/src/main/java/pro/gravit/launchserver/command/modules/LoadModuleCommand.java',
    'components/launchserver/src/main/java/pro/gravit/launchserver/command/modules/LoadLauncherModuleCommand.java',
  ],
} as const

const AUTH_MODULE_NAMES = new Set(['AdditionalHash', 'DiscordAuthSystem', 'FileAuthSystem', 'MojangSupport'])

const module = (
  name: string,
  kind: GravitModuleKind,
  description: string,
  sourceOverride?: GravitModuleItemSource,
  jarOverride?: string,
): GravitModuleCatalogItem => {
  const suffix = kind === 'server' ? '_module' : '_lmodule'
  const directory = `${name}${suffix}`
  const category: GravitModuleCategory =
    kind === 'server' && AUTH_MODULE_NAMES.has(name) ? 'auth' : kind
  return {
    id: directory,
    name,
    directory,
    jar: jarOverride ?? `${directory}.jar`,
    kind,
    category,
    description,
    source: sourceOverride ?? {
      repository: moduleCatalogSource.repository,
      revision: moduleCatalogSource.revision,
      path: directory,
    },
  }
}

const allServerModules = [
  module('AdditionalHash', 'server', 'Adds PHPASS password hash verification.'),
  module(
    'DiscordAuthSystem',
    'server',
    'Built-in standalone Discord OAuth auth provider with auto-register, guild checks, and safe nickname formatting.',
    discordAuthSystemSource,
    discordAuthSystemJarName,
  ),
  module('FileAuthSystem', 'server', 'Provides file-backed authentication for development setups.'),
  module('FxRuntimeOptimizer', 'server', 'Optimizes JavaFX runtime packaging.'),
  module('GenerateCertificate', 'server', 'Generates certificates for launcher artifact signing.'),
  module('MirrorHelper', 'server', 'Adds client, mod, workspace, and authlib helper commands.'),
  module('MojangSupport', 'server', 'Adds Mojang and Microsoft account support.'),
  module('OpenSSLSignCode', 'server', 'Signs Windows executables through OpenSSL tooling.'),
  module('Prestarter', 'server', 'Integrates LauncherPrestarter into launcher builds.'),
  module('RemoteControl', 'server', 'Exposes allowlisted LaunchServer commands over HTTP.'),
  module('SentryProGuardUpload', 'server', 'Uploads ProGuard mappings for Sentry symbolication.'),
  module('Sentry', 'server', 'Reports LaunchServer errors to Sentry.'),
  module('SystemdNotifer', 'server', 'Reports LaunchServer readiness to systemd.'),
  module('UnsafeCommandPack', 'server', 'Adds advanced commands that require careful review.'),
]

const launcherModules = [
  module('DiscordGame', 'launcher', 'Publishes launcher game activity to Discord.'),
  module('LauncherGuard', 'launcher', 'Adds native launcher protection integration.'),
  module('LauncherStartScreen', 'launcher', 'Shows a loading screen before runtime initialization.'),
  module('Sentry', 'launcher', 'Reports launcher runtime errors to Sentry.'),
]

export const authModules = allServerModules.filter((item) => item.category === 'auth')
export const serverModules = allServerModules.filter((item) => item.category === 'server')
export const moduleCatalogItems = [...allServerModules, ...launcherModules]

export const moduleCatalog: GravitModuleCatalog = {
  source: moduleCatalogSource,
  release: moduleRelease,
  commandSource: moduleCommandSource,
  serverModules,
  launcherModules,
  authModules,
}

export const findCatalogModule = (id: string) =>
  moduleCatalogItems.find((item) => item.id === id) ?? null
