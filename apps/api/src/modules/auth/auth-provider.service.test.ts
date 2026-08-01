import { describe, expect, test } from 'bun:test'
import type { AuthProviderApplyInput, GravitInstallation } from '@gravit-panel/shared'
import type { ControlFileService } from '../gravit/control-file.service'
import type { JobTaskContext } from '../jobs/jobs.runner'
import type { ModuleManagementService } from '../modules/module-management.service'
import { AuthProviderService } from './auth-provider.service'

const installation: GravitInstallation = {
  id: '0da297da-3055-4785-aa1a-57fba3beba11',
  name: 'default',
  path: '/srv/gravit/default',
  address: 'localhost:17549',
  projectName: 'MY_PROJECT',
  sourceRepository: 'https://github.com/GravitLauncher/LauncherDockered',
  sourceRevision: '723203b56f8d58f2447edd20ac8a5b84a31ef816',
  createdAt: '2026-07-27T12:00:00.000Z',
  updatedAt: '2026-07-27T12:00:00.000Z',
}

const context = (): JobTaskContext => ({
  signal: new AbortController().signal,
  log: () => {},
  progress: () => {},
})

describe('AuthProviderService.applyProvider', () => {
  test('writes a memory auth core after snapshot and verifies the type', async () => {
    let config = JSON.stringify({
      auth: {
        std: {
          isDefault: true,
          displayName: 'Default',
          visible: true,
          core: { type: 'reject' },
        },
      },
    })
    const written: string[] = []
    const volume = {
      exists: async () => false,
      readFile: async () => config,
      copy: async () => {},
      writeFileAtomic: async (_installation: GravitInstallation, path: string, bytes: Uint8Array) => {
        expect(path).toBe('LaunchServer.json')
        config = new TextDecoder().decode(bytes)
        written.push(config)
      },
    }
    const modules = { install: async () => ({} as never) } as Pick<
      ModuleManagementService,
      'install'
    >
    const service = new AuthProviderService({} as ControlFileService, volume, modules, {
      restartLaunchServer: async () => {},
    })

    const input: AuthProviderApplyInput = {
      installationId: installation.id,
      authId: 'std',
      recipeId: 'memory',
      displayName: 'Default',
      isDefault: true,
      visible: true,
      confirmConfigWrite: true,
    }
    const result = await service.applyProvider(installation, input, context())

    expect(result.coreType).toBe('memory')
    expect(result.restarted).toBe(true)
    expect(JSON.parse(written[0]!).auth.std.core.type).toBe('memory')
  })

  test('redacts SQL passwords from provider detail responses', async () => {
    const volume = {
      exists: async () => false,
      readFile: async () =>
        JSON.stringify({
          auth: {
            std: {
              isDefault: true,
              displayName: 'SQL',
              core: {
                type: 'sql',
                holder: {
                  driverClass: 'org.postgresql.Driver',
                  jdbcUrl: 'jdbc:postgresql://localhost:5432/db',
                  username: 'root',
                  password: 'super-secret',
                },
                passwordVerifier: { type: 'bcrypt', cost: 10 },
              },
            },
          },
        }),
      copy: async () => {},
      writeFileAtomic: async () => {},
    }
    const service = new AuthProviderService({} as ControlFileService, volume)

    const detail = await service.providerDetail(installation, 'std')

    expect(detail.sql?.holder.passwordConfigured).toBe(true)
    expect(JSON.stringify(detail)).not.toContain('super-secret')
  })

  test('prefills Discord configuration without exposing its client secret', async () => {
    const discordConfig = {
      clientId: 'discord-client-id',
      clientSecret: 'discord-client-secret',
      redirectUrl: 'https://launcher.example.test/webapi/auth/discord',
      discordAuthorizeUrl: 'https://discord.example.test/authorize',
      discordTokenUrl: 'https://discord.example.test/token',
      discordApiEndpoint: 'https://discord.example.test/api',
      requiredGuildIds: ['123456789012345678'],
      useGlobalNickname: false,
      usernameRegex: '^[a-z]+$',
      usernameFormat: 'discord-{discord}',
      autoRegister: false,
    }
    const volume = {
      exists: async (_installation: GravitInstallation, path: string) =>
        path === 'config/DiscordAuthSystem/Config.json',
      readFile: async (_installation: GravitInstallation, path: string) => {
        if (path === 'config/DiscordAuthSystem/Config.json') return JSON.stringify(discordConfig)
        return JSON.stringify({
          auth: {
            std: {
              displayName: 'Discord',
              core: { type: 'discordauthsystem' },
            },
          },
        })
      },
      copy: async () => {},
      writeFileAtomic: async () => {},
    }
    const service = new AuthProviderService({} as ControlFileService, volume)

    const detail = await service.providerDetail(installation, 'std')

    const { clientSecret: _clientSecret, ...expectedConfig } = discordConfig
    expect(detail.discord).toEqual({
      ...expectedConfig,
      clientSecretConfigured: true,
    })
    expect(JSON.stringify(detail)).not.toContain('discord-client-secret')
  })

  test('keeps the stored Discord secret when a reconfiguration leaves it blank', async () => {
    let launchServerConfig = JSON.stringify({
      auth: {
        std: { displayName: 'Discord', core: { type: 'discordauthsystem' } },
      },
    })
    let discordConfig = JSON.stringify({
      clientId: 'existing-client',
      clientSecret: 'existing-secret',
      redirectUrl: 'https://example.test/discord',
    })
    const writes: Record<string, string> = {}
    const volume = {
      exists: async (_installation: GravitInstallation, path: string) =>
        [
          'modules/DiscordAuthSystem_module.jar',
          'modules/.gravit-panel-discordauthsystem-version',
          'config/DiscordAuthSystem/Config.json',
        ].includes(path),
      readFile: async (_installation: GravitInstallation, path: string) => {
        if (path === 'LaunchServer.json') return launchServerConfig
        if (path === 'config/DiscordAuthSystem/Config.json') return discordConfig
        if (path === 'modules/.gravit-panel-discordauthsystem-version') return '1.0.10\n'
        throw new Error(`Unexpected read: ${path}`)
      },
      copy: async () => {},
      writeFileAtomic: async (_installation: GravitInstallation, path: string, bytes: Uint8Array) => {
        const value = new TextDecoder().decode(bytes)
        writes[path] = value
        if (path === 'LaunchServer.json') launchServerConfig = value
        if (path === 'config/DiscordAuthSystem/Config.json') discordConfig = value
      },
    }
    const service = new AuthProviderService(
      {} as ControlFileService,
      volume,
      { install: async () => ({} as never) },
      { restartLaunchServer: async () => {} },
    )

    await service.applyProvider(
      installation,
      {
        installationId: installation.id,
        authId: 'std',
        recipeId: 'discord',
        displayName: 'Discord',
        isDefault: true,
        visible: true,
        discord: {
          clientId: 'updated-client',
          redirectUrl: 'https://example.test/updated-discord',
          discordAuthorizeUrl: 'https://discord.com/oauth2/authorize',
          discordTokenUrl: 'https://discord.com/api/oauth2/token',
          discordApiEndpoint: 'https://discord.com/api/v10',
          requiredGuildIds: [],
          useGlobalNickname: true,
          usernameRegex: '^[a-zA-Z0-9_]{3,16}$',
          usernameFormat: '{discord}',
          autoRegister: true,
        },
        confirmConfigWrite: true,
      },
      context(),
    )

    expect(JSON.parse(writes['config/DiscordAuthSystem/Config.json']!).clientSecret).toBe(
      'existing-secret',
    )
  })

  test('builds and publishes DiscordAuthSystem before configuring a Discord provider', async () => {
    let launchServerConfig = JSON.stringify({
      auth: {
        std: {
          isDefault: true,
          displayName: 'Default',
          visible: true,
          core: { type: 'reject' },
        },
      },
    })
    let published = false
    let builds = 0
    let moduleInstalls = 0
    const writes: Record<string, string> = {}
    const volume = {
      exists: async (_installation: GravitInstallation, path: string) =>
        path === 'modules/DiscordAuthSystem_module.jar' && published,
      readFile: async (_installation: GravitInstallation, path: string) => {
        if (path !== 'LaunchServer.json') throw new Error(`Unexpected read: ${path}`)
        return launchServerConfig
      },
      copy: async () => {},
      writeFileAtomic: async (
        _installation: GravitInstallation,
        path: string,
        bytes: Uint8Array,
      ) => {
        const value = new TextDecoder().decode(bytes)
        writes[path] = value
        if (path === 'LaunchServer.json') launchServerConfig = value
      },
    }
    const modules = {
      install: async () => {
        moduleInstalls += 1
        return {} as never
      },
    } as Pick<ModuleManagementService, 'install'>
    const builder = {
      build: async () => {
        builds += 1
        published = true
        return {
          jarPath: '/tmp/DiscordAuthSystem_module.jar',
          installationId: installation.id,
          copiedToInstallation: true,
        }
      },
    }
    const service = new AuthProviderService(
      {} as ControlFileService,
      volume,
      modules,
      { restartLaunchServer: async () => {} },
      builder,
    )

    const result = await service.applyProvider(
      installation,
      {
        installationId: installation.id,
        authId: 'std',
        recipeId: 'discord',
        displayName: 'Discord',
        isDefault: true,
        visible: true,
        discord: {
          clientId: 'client-id',
          clientSecret: 'client-secret',
          redirectUrl: 'https://example.test/discord',
          discordAuthorizeUrl: 'https://discord.com/oauth2/authorize',
          discordTokenUrl: 'https://discord.com/api/oauth2/token',
          discordApiEndpoint: 'https://discord.com/api/v10',
          requiredGuildIds: [],
          useGlobalNickname: true,
          usernameRegex: '^[a-zA-Z0-9_]{3,16}$',
          usernameFormat: '{discord}',
          autoRegister: true,
        },
        confirmConfigWrite: true,
      },
      context(),
    )

    expect(builds).toBe(1)
    expect(moduleInstalls).toBe(1)
    expect(JSON.parse(writes['config/DiscordAuthSystem/Config.json']!).clientId).toBe('client-id')
    expect(result.coreType).toBe('discordauthsystem')
  })
})
