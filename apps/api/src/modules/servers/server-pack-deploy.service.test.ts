import { Database } from 'bun:sqlite'
import { expect, test } from 'bun:test'
import { schema } from '../../db/schema'
import { ServerAgentEventHub } from './server-agent.events'
import { ServerAgentService } from './server-agent.service'
import { ServerAgentStore } from './server-agent.store'
import { ServerBindingsStore } from './server-bindings.store'
import { ServerPackDeployService } from './server-pack-deploy.service'

const harness = () => {
  const db = new Database(':memory:')
  db.exec(schema)
  const installationId = crypto.randomUUID()
  const bindingId = crypto.randomUUID()
  const packVersionId = crypto.randomUUID()
  const now = new Date().toISOString()
  db.exec('PRAGMA foreign_keys = OFF')
  db.query(`
    INSERT INTO gravit_installations (
      id, name, path, address, project_name, source_repository,
      source_revision, created_at, updated_at
    ) VALUES (?, 'default', '/tmp/test', 'localhost', 'TEST', 'repo', 'rev', ?, ?)
  `).run(installationId, now, now)
  db.query(`
    INSERT INTO server_bindings (
      id, installation_id, profile_name, server_name, server_address,
      server_port, is_default, auth_id, pack_version_id, xms, xmx,
      jvm_args_json, game_args_json, deployment_state, updater_installed_at,
      created_at, updated_at
    ) VALUES (?, ?, 'main', 'Survival', 'localhost', 25565, 1, 'std', ?,
      '1G', '4G', '[]', '["nogui"]', 'requires-update', ?, ?, ?)
  `).run(bindingId, installationId, packVersionId, now, now, now)
  db.exec('PRAGMA foreign_keys = ON')
  const bindings = new ServerBindingsStore(db)
  const agentStore = new ServerAgentStore(db)
  const agents = new ServerAgentService(agentStore, new ServerAgentEventHub(), () => null)
  return {
    bindingId,
    packVersionId,
    bindings,
    agentStore,
    service: new ServerPackDeployService(bindings, agents, agentStore),
  }
}

test('waits for the persisted updater report before completing deployment', async () => {
  const { bindingId, packVersionId, bindings, agentStore, service } = harness()
  const deployment = service.deploy(bindingId, packVersionId, new AbortController().signal, () => {})
  await Bun.sleep(10)
  const command = agentStore.pendingCommands(bindingId)[0]
  expect(command?.type).toBe('pack.apply')
  agentStore.finishCommand(command!.id, 'queued')

  let settled = false
  void deployment.finally(() => { settled = true })
  await Bun.sleep(20)
  expect(settled).toBeFalse()

  bindings.reportPack(bindingId, packVersionId)
  expect(await deployment).toMatchObject({ bindingId, packVersionId, commandId: command!.id })
})

test('fails deployment when the agent command fails', async () => {
  const { bindingId, packVersionId, agentStore, service } = harness()
  const deployment = service.deploy(bindingId, packVersionId, new AbortController().signal, () => {})
  await Bun.sleep(10)
  const command = agentStore.pendingCommands(bindingId)[0]
  agentStore.finishCommand(command!.id, undefined, 'systemctl failed')
  await expect(deployment).rejects.toThrow('systemctl failed')
})
