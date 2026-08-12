import type { ProfileServerBinding } from '@gravit-panel/shared'
import type { ServerAgentService } from './server-agent.service'
import type { ServerAgentStore } from './server-agent.store'
import type { ServerBindingsStore } from './server-bindings.store'

export class ServerPackDeployService {
  constructor(
    private readonly bindings: ServerBindingsStore,
    private readonly agents: ServerAgentService,
    private readonly agentStore: ServerAgentStore,
  ) {}

  async deploy(
    bindingId: string,
    packVersionId: string,
    signal: AbortSignal,
    progress: (value: number, message: string) => void,
  ) {
    progress(5, 'Requesting immediate server pack update')
    const command = this.agents.createCommand(bindingId, 'pack.apply', {})
    progress(20, 'Waiting for the host updater report')
    const deadline = Date.now() + 10 * 60_000
    while (Date.now() < deadline) {
      if (signal.aborted) throw new Error('Server pack deployment cancelled')
      const binding = this.bindings.get(bindingId)
      if (!binding) throw new Error('Managed server binding was removed')
      if (binding.packVersionId !== packVersionId) {
        throw new Error('Desired server pack changed while deployment was running')
      }
      if (binding.appliedPackVersionId === packVersionId) {
        progress(95, 'Server pack application confirmed')
        return {
          bindingId,
          packVersionId,
          commandId: command.id,
          appliedAt: binding.updaterLastSeenAt,
        }
      }
      const currentCommand = this.agentStore.getCommand(command.id)
      if (currentCommand?.status === 'failed') {
        throw new Error(currentCommand.error ?? 'Host agent failed to start the pack updater')
      }
      if (binding.updaterError) throw new Error(binding.updaterError)
      await Bun.sleep(1000)
    }
    throw new Error('Timed out waiting for the server pack updater report')
  }

  validate(binding: ProfileServerBinding) {
    if (!binding.updaterInstalledAt) throw new Error('Server pack updater is not installed.')
    if (!binding.packVersionId || binding.packVersionId === binding.appliedPackVersionId) {
      throw new Error('The desired server pack is already applied.')
    }
    const runtime = this.agents.runtime(binding.id!)
    if (!runtime.connected || !runtime.capabilities.includes('pack-updater')) {
      throw new Error('Connected host agent does not support immediate pack updates.')
    }
    return binding.packVersionId
  }
}
