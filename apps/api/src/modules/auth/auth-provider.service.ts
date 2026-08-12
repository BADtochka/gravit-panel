import type {
  AuthConfiguration,
  AuthCoreRecipeId,
  AuthDiscordCoreConfig,
  AuthDiscordCoreInput,
  AuthHttpCoreConfig,
  AuthPasswordVerifierConfig,
  AuthProviderApplyInput,
  AuthProviderApplyResult,
  AuthProviderDetail,
  AuthProviderSummary,
  AuthSqlCoreConfig,
  AuthSqlDriverPreset,
  AuthTextureProviderConfig,
  FileAuthInstallResult,
  GravitInstallation,
} from '@gravit-panel/shared'
import { join } from 'node:path'
import { env } from '../../core/env'
import type { AuthControlCommand, ControlFileService } from '../gravit/control-file.service'
import { ContainerVolumeService } from '../docker/container-volume.service'
import type { LauncherDockeredService } from '../docker/launcherdockered.service'
import type { JobTaskContext } from '../jobs/jobs.runner'
import { DiscordAuthSystemBuildService } from '../modules/discord-auth-system-build.service'
import {
  discordAuthSystemArtifactVersion,
  findCatalogModule,
} from '../modules/module-catalog'
import { ModuleManagementService } from '../modules/module-management.service'
import {
  authRecipes,
  authWikiSource,
  fileAuthRecipeSource,
  mojangSupportSource,
} from './auth-recipes'

interface LaunchServerAuthPair {
  isDefault?: boolean
  displayName?: string
  visible?: boolean
  core?: Record<string, unknown>
  textureProvider?: Record<string, unknown>
}

interface LaunchServerConfig {
  auth?: Record<string, LaunchServerAuthPair>
}

interface AuthVolumeOperations {
  exists?(installation: GravitInstallation, relativePath: string): Promise<boolean>
  readFile(installation: GravitInstallation, relativePath: string): Promise<string>
  writeFileAtomic(
    installation: GravitInstallation,
    relativePath: string,
    bytes: Uint8Array,
    mode?: '0600' | '0644' | '0755',
  ): Promise<void>
  copy(installation: GravitInstallation, source: string, target: string): Promise<void>
}

type AuthControlTransport = Pick<
  ControlFileService,
  'executeAuthCommand' | 'executeModuleCommand'
>

const authIdPattern = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/
const safeTimestamp = () => new Date().toISOString().replaceAll(':', '-').replaceAll('.', '-')
const configPath = 'LaunchServer.json'
const discordModuleConfigPath = 'config/DiscordAuthSystem/Config.json'

const sqlDrivers: Record<
  AuthSqlDriverPreset,
  { driverClass: string; jdbcPrefix: string }
> = {
  postgresql: {
    driverClass: 'org.postgresql.Driver',
    jdbcPrefix: 'jdbc:postgresql://',
  },
  mariadb: {
    driverClass: 'org.mariadb.jdbc.Driver',
    jdbcPrefix: 'jdbc:mariadb://',
  },
  mysql: {
    driverClass: 'com.mysql.cj.jdbc.Driver',
    jdbcPrefix: 'jdbc:mysql://',
  },
}

const fileAuthModule = (() => {
  const item = findCatalogModule('FileAuthSystem_module')
  if (!item) throw new Error('FileAuthSystem is missing from the verified module catalog')
  return item
})()

const mojangSupportModule = (() => {
  const item = findCatalogModule('MojangSupport_module')
  if (!item) throw new Error('MojangSupport is missing from the verified module catalog')
  return item
})()

const additionalHashModule = (() => {
  const item = findCatalogModule('AdditionalHash_module')
  if (!item) throw new Error('AdditionalHash is missing from the verified module catalog')
  return item
})()

const discordAuthSystemModule = (() => {
  const item = findCatalogModule('DiscordAuthSystem_module')
  if (!item) throw new Error('DiscordAuthSystem is missing from the module catalog')
  return item
})()

const recipeSource = (recipeId: AuthCoreRecipeId) => {
  if (recipeId === 'file') return fileAuthRecipeSource
  if (recipeId === 'mojang' || recipeId === 'microsoft') return mojangSupportSource
  const recipe = authRecipes.find((item) => item.id === recipeId)
  if (recipe) return recipe.source
  return authWikiSource
}

export class AuthProviderService {
  constructor(
    private readonly control: AuthControlTransport,
    private readonly volume: AuthVolumeOperations = new ContainerVolumeService(),
    private readonly modules: Pick<ModuleManagementService, 'install'> = new ModuleManagementService(
      control,
    ),
    private readonly lifecycle: Pick<LauncherDockeredService, 'restartLaunchServer'> | null = null,
    private readonly discordModuleBuilder: Pick<DiscordAuthSystemBuildService, 'build'> =
      new DiscordAuthSystemBuildService(),
  ) {}

  async configuration(installation: GravitInstallation): Promise<AuthConfiguration> {
    const config = await this.readConfig(installation)
    return {
      installationId: installation.id,
      providers: this.providerSummaries(config),
      recipes: authRecipes,
    }
  }

  async providerDetail(
    installation: GravitInstallation,
    authId: string,
  ): Promise<AuthProviderDetail> {
    if (!authIdPattern.test(authId)) {
      throw new Error('Auth provider id contains unsupported characters')
    }
    const config = await this.readConfig(installation)
    const pair = config.auth?.[authId]
    if (!pair) throw new Error(`Auth provider "${authId}" does not exist`)
    return this.sanitizeProvider(installation, authId, pair)
  }

  async installFileAuth(
    installation: GravitInstallation,
    authId: string,
    context: JobTaskContext,
  ): Promise<FileAuthInstallResult> {
    if (!authIdPattern.test(authId)) {
      throw new Error('Auth provider id contains unsupported characters')
    }

    const before = await this.readConfig(installation)
    const requested = before.auth?.[authId]
    if (!requested) throw new Error(`Auth provider "${authId}" does not exist`)

    await this.modules.install(installation, fileAuthModule, context, {
      checking: 5,
      loading: 15,
      verifying: 25,
      completed: 30,
    })

    const afterModuleLoad = await this.readConfig(installation)
    const existingId = this.findConfiguredFileProvider(afterModuleLoad, authId)
    if (existingId) {
      context.progress(95, `FileAuthSystem is already configured as ${existingId}`)
      return this.fileResult(installation, authId, existingId, true, null)
    }

    const backupRelativePath = `${configPath}.backup-${safeTimestamp()}`
    await this.volume.copy(installation, configPath, backupRelativePath)
    context.log(
      `LaunchServer config snapshot created: ${join(installation.path, 'launcher', backupRelativePath)}`,
    )

    const command =
      `fileauthsystem install ${authId}` satisfies AuthControlCommand
    context.progress(55, `Applying FileAuthSystem recipe to ${authId}`)
    const lines = await this.control.executeAuthCommand(installation, command)
    lines.forEach(context.log)

    context.progress(80, 'Verifying persisted auth configuration')
    const after = await this.readConfig(installation)
    const configuredAuthId = this.findConfiguredFileProvider(after, authId)
    if (!configuredAuthId) {
      throw new Error('FileAuthSystem command completed without a persisted fileauthsystem provider')
    }

    context.progress(95, `FileAuthSystem configured as ${configuredAuthId}`)
    return this.fileResult(
      installation,
      authId,
      configuredAuthId,
      false,
      join(installation.path, 'launcher', backupRelativePath),
    )
  }

  async applyProvider(
    installation: GravitInstallation,
    input: AuthProviderApplyInput,
    context: JobTaskContext,
  ): Promise<AuthProviderApplyResult> {
    if (!authIdPattern.test(input.authId)) {
      throw new Error('Auth provider id contains unsupported characters')
    }
    const recipe = authRecipes.find((item) => item.id === input.recipeId)
    if (!recipe) throw new Error(`Unknown auth recipe "${input.recipeId}"`)

    if (input.recipeId === 'file') {
      const fileResult = await this.installFileAuth(installation, input.authId, context)
      return {
        installationId: installation.id,
        authId: fileResult.configuredAuthId,
        coreType: 'fileauthsystem',
        configBackupPath: fileResult.configBackupPath,
        restarted: false,
        source: fileAuthRecipeSource,
      }
    }

    if (input.recipeId === 'mojang' || input.recipeId === 'microsoft') {
      await this.modules.install(installation, mojangSupportModule, context, {
        checking: 5,
        loading: 15,
        verifying: 25,
        completed: 30,
      })
    }

    if (input.recipeId === 'sql' && input.sql?.passwordVerifier.type === 'phpass') {
      await this.modules.install(installation, additionalHashModule, context, {
        checking: 5,
        loading: 15,
        verifying: 25,
        completed: 30,
      })
    }

    if (input.recipeId === 'discord') {
      await this.ensureDiscordModule(installation, context)
      await this.applyDiscordModuleConfig(installation, input.discord, context)
      await this.modules.install(installation, discordAuthSystemModule, context, {
        checking: 5,
        loading: 15,
        verifying: 25,
        completed: 30,
      })
    }

    const before = await this.readConfig(installation)
    if (!before.auth) throw new Error('LaunchServer configuration does not contain an auth provider map')

    if (input.recipeId === 'merge') {
      const list = input.merge?.list ?? []
      if (list.length < 2) throw new Error('Merge auth requires at least two provider ids')
      for (const id of list) {
        if (!before.auth[id]) throw new Error(`Merge list references missing provider "${id}"`)
      }
    }

    const backupRelativePath = `${configPath}.backup-${safeTimestamp()}`
    await this.volume.copy(installation, configPath, backupRelativePath)
    context.log(
      `LaunchServer config snapshot created: ${join(installation.path, 'launcher', backupRelativePath)}`,
    )

    const existing = before.auth[input.authId] ?? {}
    const nextPair = this.buildProviderPair(input, existing)
    const nextAuth = { ...before.auth }

    if (input.isDefault) {
      for (const [id, pair] of Object.entries(nextAuth)) {
        if (id === input.authId) continue
        nextAuth[id] = { ...pair, isDefault: false }
      }
    }

    nextAuth[input.authId] = nextPair
    const nextConfig: LaunchServerConfig = { ...before, auth: nextAuth }
    context.progress(55, `Writing ${recipe.coreType} auth provider ${input.authId}`)
    await this.volume.writeFileAtomic(
      installation,
      configPath,
      new TextEncoder().encode(`${JSON.stringify(nextConfig, null, 2)}\n`),
      '0644',
    )

    let restarted = false
    if (this.lifecycle) {
      context.progress(70, 'Restarting LaunchServer to load the auth provider')
      await this.lifecycle.restartLaunchServer(installation, context)
      restarted = true
    } else {
      context.log('LaunchServer restart skipped; inject lifecycle to apply auth cores live')
    }

    context.progress(90, 'Verifying persisted auth configuration')
    const after = await this.readConfig(installation)
    const applied = after.auth?.[input.authId]
    if (!applied || applied.core?.type !== recipe.coreType) {
      throw new Error(
        `Auth provider apply completed without persisting core type "${recipe.coreType}"`,
      )
    }

    context.progress(95, `Auth provider ${input.authId} configured as ${recipe.coreType}`)
    return {
      installationId: installation.id,
      authId: input.authId,
      coreType: recipe.coreType,
      configBackupPath: join(installation.path, 'launcher', backupRelativePath),
      restarted,
      source: recipeSource(input.recipeId),
    }
  }

  private async applyDiscordModuleConfig(
    installation: GravitInstallation,
    config: AuthDiscordCoreInput | undefined,
    context: JobTaskContext,
  ): Promise<void> {
    if (!config) throw new Error('Discord auth requires module configuration')
    const existing = await this.readDiscordModuleConfig(installation)
    const clientSecret = config.clientSecret || existing?.clientSecret
    if (!config.clientId || !clientSecret || !config.redirectUrl) {
      throw new Error('Discord auth requires clientId, clientSecret, and redirectUrl')
    }

    const moduleConfig = {
      clientId: config.clientId,
      clientSecret,
      redirectUrl: config.redirectUrl,
      discordAuthorizeUrl: config.discordAuthorizeUrl || 'https://discord.com/oauth2/authorize',
      discordTokenUrl: config.discordTokenUrl || 'https://discord.com/api/oauth2/token',
      discordApiEndpoint: config.discordApiEndpoint || 'https://discord.com/api/v10',
      requiredGuildIds: config.requiredGuildIds ?? [],
      useGlobalNickname: config.useGlobalNickname ?? true,
      usernameRegex: config.usernameRegex || '^[a-zA-Z0-9_]{3,16}$',
      usernameFormat: config.usernameFormat || '{discord}',
      autoRegister: config.autoRegister ?? true,
      portalRedirectUrl: `${env.LAUNCHSERVER_PUBLIC_URL.replace(/\/$/, '')}/webapi/auth/discord/portal`,
      portalCallbackUrl: `${(env.PANEL_PUBLIC_URL ?? '').replace(/\/$/, '')}/api/public/auth/callback`,
      portalHmacSecret: env.PUBLIC_PORTAL_HMAC_SECRET ?? '',
    }

    context.progress(12, 'Writing DiscordAuthSystem module configuration')
    await this.volume.writeFileAtomic(
      installation,
      discordModuleConfigPath,
      new TextEncoder().encode(`${JSON.stringify(moduleConfig, null, 2)}\n`),
      '0644',
    )
    context.log(`DiscordAuthSystem module config written: ${discordModuleConfigPath}`)
  }

  private async ensureDiscordModule(
    installation: GravitInstallation,
    context: JobTaskContext,
  ): Promise<void> {
    const jarPath = `modules/${discordAuthSystemModule.jar}`
    const versionPath = 'modules/.gravit-panel-discordauthsystem-version'
    const hasCurrentArtifact =
      (await this.volume.exists?.(installation, jarPath)) &&
      (await this.volume.exists?.(installation, versionPath)) &&
      (await this.volume.readFile(installation, versionPath)).trim() === discordAuthSystemArtifactVersion
    if (hasCurrentArtifact) {
      context.log(`Using published DiscordAuthSystem module JAR: ${jarPath}`)
      return
    }

    context.progress(5, 'Building and publishing the current DiscordAuthSystem module')
    await this.discordModuleBuilder.build(context, installation)
    if (this.lifecycle) {
      context.progress(96, 'Restarting LaunchServer with the updated DiscordAuthSystem module')
      await this.lifecycle.restartLaunchServer(installation, context)
    }
  }

  private buildProviderPair(
    input: AuthProviderApplyInput,
    existing: LaunchServerAuthPair,
  ): LaunchServerAuthPair {
    const textureProvider = input.textureProvider?.type === 'request' && input.recipeId === 'discord'
      ? (env.PANEL_PUBLIC_URL
          ? ({
              type: 'request',
              skinURL: `${env.PANEL_PUBLIC_URL.replace(/\/$/, '')}/api/public/skins/%username%.png`,
            } satisfies AuthTextureProviderConfig)
          : ({ type: 'void' } satisfies AuthTextureProviderConfig))
      : (input.textureProvider ??
        (existing.textureProvider as AuthTextureProviderConfig | undefined) ??
        ({ type: 'void' } satisfies AuthTextureProviderConfig))

    return {
      isDefault: input.isDefault,
      displayName: input.displayName,
      visible: input.visible,
      textureProvider: this.buildTextureProvider(textureProvider),
      core: this.buildCore(input, existing),
    }
  }

  private buildTextureProvider(config: AuthTextureProviderConfig) {
    if (config.type === 'void') return { type: 'void' }
    return {
      type: 'request',
      ...(config.skinURL ? { skinURL: config.skinURL } : {}),
      ...(config.cloakURL ? { cloakURL: config.cloakURL } : {}),
    }
  }

  private buildCore(input: AuthProviderApplyInput, existing: LaunchServerAuthPair) {
    switch (input.recipeId) {
      case 'memory':
        return { type: 'memory' }
      case 'mojang':
        return { type: 'mojang' }
      case 'microsoft':
        return { type: 'microsoft' }
      case 'merge':
        return {
          type: 'merge',
          list: input.merge?.list ?? [],
        }
      case 'http':
        return this.buildHttpCore(input.http, existing.core)
      case 'sql':
        return this.buildSqlCore(input.sql, existing.core)
      case 'discord':
        return { type: 'discordauthsystem' }
      default:
        throw new Error(`Recipe "${input.recipeId}" cannot be applied through JSON write`)
    }
  }

  private buildHttpCore(
    http: AuthHttpCoreConfig | undefined,
    existing: Record<string, unknown> | undefined,
  ) {
    if (!http) throw new Error('HTTP auth requires endpoint configuration')
    const existingBearer =
      typeof existing?.bearerToken === 'string' ? existing.bearerToken : undefined
    const bearerToken = http.bearerToken || existingBearer
    if (!bearerToken) throw new Error('HTTP auth requires a bearer token')
    return {
      type: 'http',
      userByUsername: http.userByUsername,
      userByUuid: http.userByUuid,
      userByToken: http.userByToken,
      refreshAccessToken: http.refreshAccessToken,
      authorize: http.authorize,
      checkServer: http.checkServer,
      joinServer: http.joinServer,
      bearerToken,
    }
  }

  private buildSqlCore(
    sql: AuthSqlCoreConfig | undefined,
    existing: Record<string, unknown> | undefined,
  ) {
    if (!sql) throw new Error('SQL auth requires database configuration')
    const driver = sqlDrivers[sql.holder.driverPreset]
    if (!driver) throw new Error('Unsupported SQL driver preset')
    if (!sql.holder.jdbcUrl.startsWith(driver.jdbcPrefix)) {
      throw new Error(`JDBC URL must start with ${driver.jdbcPrefix}`)
    }

    const existingHolder =
      existing?.holder && typeof existing.holder === 'object'
        ? (existing.holder as Record<string, unknown>)
        : null
    const existingPassword =
      typeof existingHolder?.password === 'string' ? existingHolder.password : undefined
    const password = sql.holder.password || existingPassword
    if (!password) throw new Error('SQL auth requires a database password')

    return {
      type: 'sql',
      holder: {
        driverClass: driver.driverClass,
        jdbcUrl: sql.holder.jdbcUrl,
        username: sql.holder.username,
        password,
        hikariMaxLifetime: sql.holder.hikariMaxLifetime ?? 1_800_000,
        initializeAtStart: sql.holder.initializeAtStart ?? false,
      },
      expireSeconds: sql.expireSeconds ?? 3600,
      uuidColumn: sql.uuidColumn ?? 'uuid',
      usernameColumn: sql.usernameColumn ?? 'username',
      accessTokenColumn: sql.accessTokenColumn ?? 'accesstoken',
      passwordColumn: sql.passwordColumn ?? 'password',
      serverIDColumn: sql.serverIDColumn ?? 'serverid',
      hardwareIdColumn: sql.hardwareIdColumn ?? 'hwidId',
      tableHWID: sql.tableHWID ?? 'hwids',
      tableHWIDLog: sql.tableHWIDLog ?? 'hwidLog',
      table: sql.table ?? 'users',
      passwordVerifier: this.buildPasswordVerifier(sql.passwordVerifier),
    }
  }

  private buildPasswordVerifier(config: AuthPasswordVerifierConfig) {
    switch (config.type) {
      case 'bcrypt':
        return { type: 'bcrypt', cost: config.cost ?? 10 }
      case 'digest':
        return { type: 'digest', algo: config.algo ?? 'SHA256' }
      case 'doubleDigest':
        return {
          type: 'doubleDigest',
          algo: config.algo ?? 'SHA256',
          toHexMode: config.toHexMode ?? true,
        }
      case 'phpass':
        return { type: 'phpass' }
      default:
        throw new Error(`Unsupported password verifier "${String((config as { type: string }).type)}"`)
    }
  }

  async readConfig(installation: GravitInstallation) {
    let parsed: LaunchServerConfig
    try {
      parsed = JSON.parse(await this.volume.readFile(installation, configPath)) as LaunchServerConfig
    } catch (error) {
      throw new Error(
        `Unable to read LaunchServer auth configuration: ${
          error instanceof Error ? error.message : String(error)
        }`,
        { cause: error },
      )
    }
    if (!parsed.auth || typeof parsed.auth !== 'object' || Array.isArray(parsed.auth)) {
      throw new Error('LaunchServer configuration does not contain an auth provider map')
    }
    return parsed
  }

  providerSummaries(config: LaunchServerConfig): AuthProviderSummary[] {
    return Object.entries(config.auth ?? {}).map(([id, pair]) => ({
      id,
      displayName: pair.displayName ?? id,
      coreType: typeof pair.core?.type === 'string' ? pair.core.type : 'unknown',
      isDefault: pair.isDefault === true,
      visible: pair.visible !== false,
    }))
  }

  private async sanitizeProvider(
    installation: GravitInstallation,
    id: string,
    pair: LaunchServerAuthPair,
  ): Promise<AuthProviderDetail> {
    const core = pair.core ?? {}
    const coreType = typeof core.type === 'string' ? core.type : 'unknown'
    const texture = pair.textureProvider
    const textureProvider: AuthTextureProviderConfig | null = texture
      ? {
          type: texture.type === 'request' ? 'request' : 'void',
          skinURL: typeof texture.skinURL === 'string' ? texture.skinURL : undefined,
          cloakURL: typeof texture.cloakURL === 'string' ? texture.cloakURL : undefined,
        }
      : null

    let sql: AuthProviderDetail['sql'] = null
    if (coreType === 'sql') {
      const holder =
        core.holder && typeof core.holder === 'object'
          ? (core.holder as Record<string, unknown>)
          : {}
      const verifier =
        core.passwordVerifier && typeof core.passwordVerifier === 'object'
          ? (core.passwordVerifier as Record<string, unknown>)
          : {}
      const driverClass = typeof holder.driverClass === 'string' ? holder.driverClass : ''
      const driverPreset = this.detectDriverPreset(driverClass)
      sql = {
        holder: {
          driverPreset,
          jdbcUrl: typeof holder.jdbcUrl === 'string' ? holder.jdbcUrl : '',
          username: typeof holder.username === 'string' ? holder.username : '',
          passwordConfigured: typeof holder.password === 'string' && holder.password.length > 0,
          hikariMaxLifetime:
            typeof holder.hikariMaxLifetime === 'number' ? holder.hikariMaxLifetime : undefined,
          initializeAtStart:
            typeof holder.initializeAtStart === 'boolean' ? holder.initializeAtStart : undefined,
        },
        expireSeconds: typeof core.expireSeconds === 'number' ? core.expireSeconds : undefined,
        table: typeof core.table === 'string' ? core.table : undefined,
        uuidColumn: typeof core.uuidColumn === 'string' ? core.uuidColumn : undefined,
        usernameColumn: typeof core.usernameColumn === 'string' ? core.usernameColumn : undefined,
        accessTokenColumn:
          typeof core.accessTokenColumn === 'string' ? core.accessTokenColumn : undefined,
        passwordColumn: typeof core.passwordColumn === 'string' ? core.passwordColumn : undefined,
        serverIDColumn: typeof core.serverIDColumn === 'string' ? core.serverIDColumn : undefined,
        hardwareIdColumn:
          typeof core.hardwareIdColumn === 'string' ? core.hardwareIdColumn : undefined,
        tableHWID: typeof core.tableHWID === 'string' ? core.tableHWID : undefined,
        tableHWIDLog: typeof core.tableHWIDLog === 'string' ? core.tableHWIDLog : undefined,
        passwordVerifier: {
          type:
            verifier.type === 'digest' ||
            verifier.type === 'doubleDigest' ||
            verifier.type === 'phpass'
              ? verifier.type
              : 'bcrypt',
          algo: typeof verifier.algo === 'string' ? verifier.algo : undefined,
          cost: typeof verifier.cost === 'number' ? verifier.cost : undefined,
          toHexMode: typeof verifier.toHexMode === 'boolean' ? verifier.toHexMode : undefined,
        },
      }
    }

    let http: AuthProviderDetail['http'] = null
    if (coreType === 'http') {
      http = {
        userByUsername: typeof core.userByUsername === 'string' ? core.userByUsername : '',
        userByUuid: typeof core.userByUuid === 'string' ? core.userByUuid : '',
        userByToken: typeof core.userByToken === 'string' ? core.userByToken : '',
        refreshAccessToken:
          typeof core.refreshAccessToken === 'string' ? core.refreshAccessToken : '',
        authorize: typeof core.authorize === 'string' ? core.authorize : '',
        checkServer: typeof core.checkServer === 'string' ? core.checkServer : '',
        joinServer: typeof core.joinServer === 'string' ? core.joinServer : '',
        bearerConfigured: typeof core.bearerToken === 'string' && core.bearerToken.length > 0,
      }
    }

    let merge: AuthProviderDetail['merge'] = null
    if (coreType === 'merge') {
      merge = {
        list: Array.isArray(core.list)
          ? core.list.filter((item): item is string => typeof item === 'string')
          : [],
      }
    }

    let discord: AuthProviderDetail['discord'] = null
    if (coreType === 'discordauthsystem') {
      const config = await this.readDiscordModuleConfig(installation)
      discord = {
        clientId: config?.clientId ?? '',
        redirectUrl: config?.redirectUrl ?? '',
        discordAuthorizeUrl:
          config?.discordAuthorizeUrl ?? 'https://discord.com/oauth2/authorize',
        discordTokenUrl: config?.discordTokenUrl ?? 'https://discord.com/api/oauth2/token',
        discordApiEndpoint: config?.discordApiEndpoint ?? 'https://discord.com/api/v10',
        requiredGuildIds: config?.requiredGuildIds ?? [],
        useGlobalNickname: config?.useGlobalNickname ?? true,
        usernameRegex: config?.usernameRegex ?? '^[a-zA-Z0-9_]{3,16}$',
        usernameFormat: config?.usernameFormat ?? '{discord}',
        autoRegister: config?.autoRegister ?? true,
        clientSecretConfigured: Boolean(config?.clientSecret),
      }
    }

    return {
      id,
      displayName: pair.displayName ?? id,
      coreType,
      isDefault: pair.isDefault === true,
      visible: pair.visible !== false,
      textureProvider,
      sql,
      http,
      discord,
      merge,
    }
  }

  private detectDriverPreset(driverClass: string): AuthSqlDriverPreset {
    if (driverClass.includes('postgresql')) return 'postgresql'
    if (driverClass.includes('mariadb')) return 'mariadb'
    return 'mysql'
  }

  private async readDiscordModuleConfig(
    installation: GravitInstallation,
  ): Promise<AuthDiscordCoreConfig | null> {
    if (this.volume.exists && !(await this.volume.exists(installation, discordModuleConfigPath))) {
      return null
    }

    let parsed: unknown
    try {
      parsed = JSON.parse(await this.volume.readFile(installation, discordModuleConfigPath))
    } catch (error) {
      throw new Error(
        `Unable to read DiscordAuthSystem configuration: ${
          error instanceof Error ? error.message : String(error)
        }`,
        { cause: error },
      )
    }
    const value = parsed && typeof parsed === 'object' ? parsed as Record<string, unknown> : {}
    return {
      clientId: typeof value.clientId === 'string' ? value.clientId : '',
      clientSecret: typeof value.clientSecret === 'string' ? value.clientSecret : '',
      redirectUrl: typeof value.redirectUrl === 'string' ? value.redirectUrl : '',
      discordAuthorizeUrl:
        typeof value.discordAuthorizeUrl === 'string'
          ? value.discordAuthorizeUrl
          : 'https://discord.com/oauth2/authorize',
      discordTokenUrl:
        typeof value.discordTokenUrl === 'string'
          ? value.discordTokenUrl
          : 'https://discord.com/api/oauth2/token',
      discordApiEndpoint:
        typeof value.discordApiEndpoint === 'string'
          ? value.discordApiEndpoint
          : 'https://discord.com/api/v10',
      requiredGuildIds: Array.isArray(value.requiredGuildIds)
        ? value.requiredGuildIds.filter((item): item is string => typeof item === 'string')
        : [],
      useGlobalNickname:
        typeof value.useGlobalNickname === 'boolean' ? value.useGlobalNickname : true,
      usernameRegex:
        typeof value.usernameRegex === 'string' ? value.usernameRegex : '^[a-zA-Z0-9_]{3,16}$',
      usernameFormat: typeof value.usernameFormat === 'string' ? value.usernameFormat : '{discord}',
      autoRegister: typeof value.autoRegister === 'boolean' ? value.autoRegister : true,
    }
  }

  private findConfiguredFileProvider(config: LaunchServerConfig, requestedAuthId: string) {
    if (config.auth?.[requestedAuthId]?.core?.type === 'fileauthsystem') {
      return requestedAuthId
    }
    if (config.auth?.fileauthsystem?.core?.type === 'fileauthsystem') {
      return 'fileauthsystem'
    }
    return null
  }

  private fileResult(
    installation: GravitInstallation,
    requestedAuthId: string,
    configuredAuthId: string,
    alreadyConfigured: boolean,
    configBackupPath: string | null,
  ): FileAuthInstallResult {
    return {
      installationId: installation.id,
      requestedAuthId,
      configuredAuthId,
      alreadyConfigured,
      configBackupPath,
      source: fileAuthRecipeSource,
    }
  }
}

/** @deprecated Use AuthProviderService */
export { AuthProviderService as AuthRecipeService }
