import type {
  AuthUserCreateInput,
  AuthUserDeleteInput,
  AuthUserMutationResult,
  AuthUserPasswordInput,
  AuthUserSummary,
  AuthUsersResponse,
  GravitInstallation,
} from '@gravit-panel/shared'
import type { AuthControlCommand, ControlFileService } from '../gravit/control-file.service'
import { ContainerVolumeService } from '../docker/container-volume.service'
import type { JobTaskContext } from '../jobs/jobs.runner'

interface FileAuthUserEntity {
  username?: string
  uuid?: string
  password?: string
}

interface LaunchServerConfig {
  auth?: Record<
    string,
    {
      core?: { type?: string }
    }
  >
}

interface AuthVolumeOperations {
  readFile(installation: GravitInstallation, relativePath: string): Promise<string>
  writeFileAtomic(
    installation: GravitInstallation,
    relativePath: string,
    bytes: Uint8Array,
    mode?: '0600' | '0644' | '0755',
  ): Promise<void>
  exists(installation: GravitInstallation, relativePath: string, kind?: 'file' | 'directory'): Promise<boolean>
}

type AuthControlTransport = Pick<ControlFileService, 'executeAuthCommand'>

const authIdPattern = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/
const usernamePattern = /^[a-zA-Z0-9_][a-zA-Z0-9_]{1,15}$/
const emailPattern = /^[^\s@]+@[^\s@]+\.[^\s@]+$/
const databasePath = 'config/FileAuthSystem/Database.json'
const launchServerConfigPath = 'LaunchServer.json'

const unmanagedReason = (coreType: string) => {
  switch (coreType) {
    case 'memory':
      return 'Memory auth does not persist users. Configure FileAuthSystem for managed accounts.'
    case 'sql':
      return 'SQL auth users live in the external database. Manage them through your CMS or SQL tools.'
    case 'http':
      return 'HTTP auth delegates user storage to your external API endpoints.'
    case 'mojang':
    case 'microsoft':
      return 'Official account auth has no local user directory.'
    case 'merge':
      return 'Merge auth only combines providers for server tokens and cannot manage users directly.'
    default:
      return `Provider core "${coreType}" does not support in-panel user management.`
  }
}

export class AuthUsersService {
  constructor(
    private readonly control: AuthControlTransport,
    private readonly volume: AuthVolumeOperations = new ContainerVolumeService(),
  ) {}

  async list(installation: GravitInstallation, authId: string): Promise<AuthUsersResponse> {
    this.assertAuthId(authId)
    const coreType = await this.coreType(installation, authId)

    if (coreType !== 'fileauthsystem') {
      return {
        installationId: installation.id,
        authId,
        coreType,
        managed: false,
        reason: unmanagedReason(coreType),
        users: [],
      }
    }

    // FileAuthSystem keeps users in memory until save/close; flush before reading.
    await this.save(installation, authId)

    return {
      installationId: installation.id,
      authId,
      coreType,
      managed: true,
      reason: null,
      users: await this.readUsers(installation),
    }
  }

  async create(
    installation: GravitInstallation,
    input: AuthUserCreateInput,
    context: JobTaskContext,
  ): Promise<AuthUserMutationResult> {
    await this.assertManaged(installation, input.authId)
    this.assertUsername(input.username)
    if (!emailPattern.test(input.email)) throw new Error('Email address is invalid')
    if (input.password.length < 4 || input.password.length > 128) {
      throw new Error('Password must be between 4 and 128 characters')
    }
    if (/\s/.test(input.password)) throw new Error('Password must not contain whitespace')

    if (await this.userExists(installation, input.authId, input.username)) {
      throw new Error(`User "${input.username}" is already registered`)
    }

    const command =
      `config auth.${input.authId}.core register ${input.username} ${input.email} ${input.password}` satisfies AuthControlCommand
    context.progress(40, `Registering FileAuthSystem user ${input.username}`)
    try {
      const lines = await this.control.executeAuthCommand(installation, command)
      lines.forEach(context.log)
    } catch (error) {
      if (await this.userExists(installation, input.authId, input.username)) {
        throw new Error(`User "${input.username}" is already registered`)
      }
      throw error
    }

    context.progress(75, 'Persisting FileAuthSystem database')
    await this.save(installation, input.authId)
    context.progress(90, `Registered ${input.username}`)
    return {
      installationId: installation.id,
      authId: input.authId,
      username: input.username,
    }
  }

  async setPassword(
    installation: GravitInstallation,
    input: AuthUserPasswordInput,
    context: JobTaskContext,
  ): Promise<AuthUserMutationResult> {
    await this.assertManaged(installation, input.authId)
    this.assertUsername(input.username)
    if (input.password.length < 4 || input.password.length > 128) {
      throw new Error('Password must be between 4 and 128 characters')
    }
    if (/\s/.test(input.password)) throw new Error('Password must not contain whitespace')

    if (!(await this.userExists(installation, input.authId, input.username))) {
      throw new Error(`User "${input.username}" was not found`)
    }

    const command =
      `config auth.${input.authId}.core changePassword ${input.username} ${input.password}` satisfies AuthControlCommand
    context.progress(40, `Updating password for ${input.username}`)
    const lines = await this.control.executeAuthCommand(installation, command)
    lines.forEach(context.log)
    context.progress(75, 'Persisting FileAuthSystem database')
    await this.save(installation, input.authId)
    context.progress(90, `Password updated for ${input.username}`)
    return {
      installationId: installation.id,
      authId: input.authId,
      username: input.username,
    }
  }

  async delete(
    installation: GravitInstallation,
    input: AuthUserDeleteInput,
    context: JobTaskContext,
  ): Promise<AuthUserMutationResult> {
    await this.assertManaged(installation, input.authId)
    this.assertUsername(input.username)

    context.progress(15, 'Flushing FileAuthSystem database before delete')
    await this.save(installation, input.authId)

    context.progress(30, `Loading FileAuthSystem database`)
    const database = await this.readDatabase(installation)
    const entry = Object.entries(database).find(
      ([, user]) => user.username?.toLowerCase() === input.username.toLowerCase(),
    )
    if (!entry) throw new Error(`User "${input.username}" was not found`)

    const [, user] = entry
    delete database[entry[0]]
    context.progress(55, `Removing ${user.username ?? input.username} from Database.json`)
    await this.volume.writeFileAtomic(
      installation,
      databasePath,
      new TextEncoder().encode(`${JSON.stringify(database, null, 2)}\n`),
      '0644',
    )

    const reload =
      `config auth.${input.authId}.core reload` satisfies AuthControlCommand
    context.progress(80, 'Reloading FileAuthSystem database')
    const lines = await this.control.executeAuthCommand(installation, reload)
    lines.forEach(context.log)
    context.progress(95, `Deleted ${input.username}`)
    return {
      installationId: installation.id,
      authId: input.authId,
      username: input.username,
    }
  }

  private async assertManaged(installation: GravitInstallation, authId: string) {
    const coreType = await this.coreType(installation, authId)
    if (coreType !== 'fileauthsystem') {
      throw new Error(unmanagedReason(coreType))
    }
  }

  private async save(installation: GravitInstallation, authId: string) {
    const command = `config auth.${authId}.core save` satisfies AuthControlCommand
    await this.control.executeAuthCommand(installation, command)
  }

  private async userExists(
    installation: GravitInstallation,
    authId: string,
    username: string,
  ) {
    const command =
      `config auth.${authId}.core getuserbyusername ${username}` satisfies AuthControlCommand
    const lines = await this.control.executeAuthCommand(installation, command)
    return lines.some(
      (line) =>
        new RegExp(`^User ${username}:`, 'i').test(line.trim()) ||
        new RegExp(`User '${username}'`, 'i').test(line),
    )
  }

  private async coreType(installation: GravitInstallation, authId: string) {
    let parsed: LaunchServerConfig
    try {
      parsed = JSON.parse(
        await this.volume.readFile(installation, launchServerConfigPath),
      ) as LaunchServerConfig
    } catch (error) {
      throw new Error(
        `Unable to read LaunchServer auth configuration: ${
          error instanceof Error ? error.message : String(error)
        }`,
        { cause: error },
      )
    }
    const pair = parsed.auth?.[authId]
    if (!pair) throw new Error(`Auth provider "${authId}" does not exist`)
    return pair.core?.type ?? 'unknown'
  }

  private async readUsers(installation: GravitInstallation): Promise<AuthUserSummary[]> {
    const database = await this.readDatabase(installation)
    return Object.values(database)
      .filter((user): user is FileAuthUserEntity & { username: string; uuid: string } =>
        typeof user.username === 'string' && typeof user.uuid === 'string',
      )
      .map((user) => ({
        username: user.username,
        uuid: user.uuid,
      }))
      .sort((left, right) => left.username.localeCompare(right.username))
  }

  private async readDatabase(installation: GravitInstallation) {
    if (!(await this.volume.exists(installation, databasePath))) {
      return {} as Record<string, FileAuthUserEntity>
    }
    try {
      const parsed = JSON.parse(
        await this.volume.readFile(installation, databasePath),
      ) as Record<string, FileAuthUserEntity>
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        throw new Error('Database.json must be an object map')
      }
      return parsed
    } catch (error) {
      throw new Error(
        `Unable to read FileAuthSystem database: ${
          error instanceof Error ? error.message : String(error)
        }`,
        { cause: error },
      )
    }
  }

  private assertAuthId(authId: string) {
    if (!authIdPattern.test(authId)) {
      throw new Error('Auth provider id contains unsupported characters')
    }
  }

  private assertUsername(username: string) {
    if (!usernamePattern.test(username)) {
      throw new Error('Username must be 2-16 characters of letters, numbers, or underscores')
    }
  }
}
