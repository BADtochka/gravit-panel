import type {
  GravitInstallation,
  ProfileServerBinding,
  ServerBindingInput,
} from '@gravit-panel/shared'
import type { ClientBuildService } from '../clients/client-build.service'
import type { JobTaskContext } from '../jobs/jobs.runner'
import type { ServerBindingsStore } from './server-bindings.store'

const namePattern = /^[a-zA-Z0-9][a-zA-Z0-9 ._-]{0,63}$/
const addressPattern =
  /^(?=.{1,253}$)(?:[a-zA-Z0-9](?:[a-zA-Z0-9.-]*[a-zA-Z0-9])?|\[[0-9a-fA-F:]+\])$/
const memoryPattern = /^[1-9][0-9]{0,5}[MG]$/i
const safeArgument = /^[^\u0000\r\n]{1,256}$/

export class ServerBindingService {
  constructor(
    private readonly store: ServerBindingsStore,
    private readonly clients: Pick<
      ClientBuildService,
      'getProfile' | 'replaceProfileServers'
    >,
  ) {}

  async list(installation: GravitInstallation, profileName: string) {
    const profile = await this.clients.getProfile(installation, profileName)
    const managed = new Map(
      this.store
        .list(installation.id, profileName)
        .map((binding) => [binding.name, binding]),
    )
    const items: ProfileServerBinding[] = profile.servers.map((server) => {
      const binding = managed.get(server.name)
      if (!binding) {
        return {
          ...server,
          id: null,
          installationId: installation.id,
          profileName,
          authId: null,
          packVersionId: null,
          xms: null,
          xmx: null,
          jvmArgs: [],
          gameArgs: [],
          managed: false,
          deploymentState: 'pending',
          updatedAt: null,
        }
      }
      return { ...binding, ...server }
    })
    return { items }
  }

  async apply(
    installation: GravitInstallation,
    input: ServerBindingInput,
    context: JobTaskContext,
    bindingId?: string,
  ) {
    this.validate(input)
    const profile = await this.clients.getProfile(installation, input.profileName)
    if (!profile.uuid || !profile.minecraftVersion || !profile.loader) {
      throw new Error('Profile must have UUID, Minecraft version, and loader before binding')
    }
    if (profile.loader === 'QUILT') {
      throw new Error('Quilt server bootstrap is not supported yet')
    }
    const current = bindingId ? this.store.get(bindingId) : null
    if (bindingId && (!current || current.installationId !== installation.id)) {
      throw new Error('Managed server binding not found')
    }
    const conflict = current
      ? profile.servers.find(
          (server) => server.name === input.name && server.name !== current.name,
        )
      : null
    if (conflict) throw new Error(`Server ${input.name} already exists in this profile`)

    const nextServer = {
      name: input.name,
      serverAddress: input.serverAddress,
      serverPort: input.serverPort,
      isDefault: input.isDefault || profile.servers.length === 0,
      protocol: -1,
      socketPing: true,
    }
    const remaining = profile.servers
      .filter((server) => server.name !== current?.name && server.name !== input.name)
      .map((server) => nextServer.isDefault ? { ...server, isDefault: false } : server)
    if (!nextServer.isDefault && !remaining.some((server) => server.isDefault) && remaining[0]) {
      remaining[0] = { ...remaining[0], isDefault: true }
    }
    context.progress(10, `Updating ${input.profileName} server list`)
    const result = await this.clients.replaceProfileServers(
      installation,
      input.profileName,
      [...remaining, nextServer],
      context,
    )
    const saved = this.store.save(
      { ...input, isDefault: nextServer.isDefault },
      current?.id ?? undefined,
    )
    context.progress(95, `Server ${input.name} bound to ${input.profileName}`)
    return { binding: saved, profile: result.profile, backupPath: result.backupPath }
  }

  async remove(
    installation: GravitInstallation,
    bindingId: string,
    context: JobTaskContext,
  ) {
    const binding = this.store.get(bindingId)
    if (!binding || binding.installationId !== installation.id) {
      throw new Error('Managed server binding not found')
    }
    const profile = await this.clients.getProfile(installation, binding.profileName)
    const next = profile.servers.filter((server) => server.name !== binding.name)
    if (binding.isDefault && next.length) next[0] = { ...next[0]!, isDefault: true }
    const result = await this.clients.replaceProfileServers(
      installation,
      binding.profileName,
      next,
      context,
    )
    this.store.delete(binding.id!)
    context.progress(95, `Server ${binding.name} removed from ${binding.profileName}`)
    return {
      bindingId,
      profile: result.profile,
      backupPath: result.backupPath,
      tokenRevoked: false,
    }
  }

  private validate(input: ServerBindingInput) {
    if (!namePattern.test(input.name.trim())) throw new Error('Server name is invalid')
    if (!addressPattern.test(input.serverAddress.trim())) {
      throw new Error('Server address must be a hostname or IP address without a scheme')
    }
    if (!Number.isSafeInteger(input.serverPort) || input.serverPort < 1 || input.serverPort > 65_535) {
      throw new Error('Server port must be between 1 and 65535')
    }
    if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/.test(input.authId)) {
      throw new Error('Auth provider id is invalid')
    }
    if (!memoryPattern.test(input.xms) || !memoryPattern.test(input.xmx)) {
      throw new Error('Xms and Xmx must use values such as 1G or 2048M')
    }
    const memoryMiB = (value: string) => {
      const amount = Number.parseInt(value, 10)
      return value.toUpperCase().endsWith('G') ? amount * 1024 : amount
    }
    if (memoryMiB(input.xms) > memoryMiB(input.xmx)) {
      throw new Error('Xms cannot be greater than Xmx')
    }
    for (const argument of [...input.jvmArgs, ...input.gameArgs]) {
      if (!safeArgument.test(argument)) throw new Error('JVM or game argument is unsafe')
    }
  }
}
