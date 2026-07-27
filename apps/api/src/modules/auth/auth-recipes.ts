import type { AuthRecipe } from '@gravit-panel/shared'
import { moduleCatalogSource } from '../modules/module-catalog'

export const authWikiSource = {
  repository: 'https://github.com/GravitLauncher/Launcher',
  revision: '81132768a711a0eab0e8b3b8b6c480b90f48795c',
  file: 'components/launchserver/src/main/java/pro/gravit/launchserver/auth/core/AuthCoreProvider.java',
} as const

export const fileAuthRecipeSource = {
  repository: moduleCatalogSource.repository,
  revision: moduleCatalogSource.revision,
  file:
    'FileAuthSystem_module/src/main/java/pro/gravit/launchermodules/fileauthsystem/commands/InstallCommand.java',
} as const

export const mojangSupportSource = {
  repository: moduleCatalogSource.repository,
  revision: moduleCatalogSource.revision,
  file: 'MojangSupport_module/README.md',
} as const

export const authRecipes: AuthRecipe[] = [
  {
    id: 'memory',
    title: 'Memory',
    description: 'In-memory auth for local testing. Does not persist users across restarts.',
    coreType: 'memory',
    moduleId: null,
    requiresModuleIds: [],
    source: authWikiSource,
  },
  {
    id: 'sql',
    title: 'SQL',
    description: 'JDBC auth for PostgreSQL, MariaDB, and MySQL with configurable password verifiers.',
    coreType: 'sql',
    moduleId: null,
    requiresModuleIds: [],
    source: authWikiSource,
  },
  {
    id: 'http',
    title: 'HTTP',
    description: 'Delegates auth to external HTTP endpoints with a bearer token.',
    coreType: 'http',
    moduleId: null,
    requiresModuleIds: [],
    source: authWikiSource,
  },
  {
    id: 'file',
    title: 'FileAuthSystem',
    description: 'File-backed users with SHA-256 password verification and persistent sessions.',
    coreType: 'fileauthsystem',
    moduleId: 'FileAuthSystem_module',
    requiresModuleIds: ['FileAuthSystem_module'],
    source: fileAuthRecipeSource,
  },
  {
    id: 'mojang',
    title: 'Mojang',
    description: 'Official Mojang account auth through the MojangSupport module.',
    coreType: 'mojang',
    moduleId: 'MojangSupport_module',
    requiresModuleIds: ['MojangSupport_module'],
    source: mojangSupportSource,
  },
  {
    id: 'microsoft',
    title: 'Microsoft',
    description: 'Microsoft account auth through the MojangSupport module.',
    coreType: 'microsoft',
    moduleId: 'MojangSupport_module',
    requiresModuleIds: ['MojangSupport_module'],
    source: mojangSupportSource,
  },
  {
    id: 'merge',
    title: 'Merge',
    description: 'Combines multiple auth providers for server token generation only.',
    coreType: 'merge',
    moduleId: null,
    requiresModuleIds: [],
    source: authWikiSource,
  },
]
