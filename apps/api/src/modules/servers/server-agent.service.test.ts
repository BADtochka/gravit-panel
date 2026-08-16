import { Database } from 'bun:sqlite'
import { describe, expect, test } from 'bun:test'
import { schema } from '../../db/schema'
import { ServerAgentEventHub } from './server-agent.events'
import { ServerAgentService } from './server-agent.service'
import { ServerAgentStore } from './server-agent.store'

const harness = () => {
  const db = new Database(':memory:')
  db.exec(schema)
  const installationId = crypto.randomUUID()
  const bindingId = crypto.randomUUID()
  const now = new Date().toISOString()
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
      jvm_args_json, game_args_json, deployment_state, created_at, updated_at
    ) VALUES (?, ?, 'main', 'Survival', 'localhost', 25565, 1, 'std', NULL,
      '1G', '4G', '[]', '["nogui"]', 'installed', ?, ?)
  `).run(bindingId, installationId, now, now)
  const store = new ServerAgentStore(db)
  const events = new ServerAgentEventHub()
  const service = new ServerAgentService(
    store,
    events,
    (token) => token === 'valid-token' ? { id: bindingId } : null,
  )
  return { db, installationId, bindingId, store, service }
}

describe('ServerAgentService', () => {
  test('authenticates an agent and completes a durable console command', () => {
    const { bindingId, store, service } = harness()
    const sent: string[] = []
    const socket = {
      send: (message: unknown) => sent.push(String(message)),
      close: () => {},
    }

    service.handle(socket, {
      type: 'hello',
      token: 'valid-token',
      agentVersion: '0.1.0',
      hostname: 'game-1',
      capabilities: ['systemd', 'journald', 'rcon'],
    })
    const command = service.createCommand(bindingId, 'console.execute', { command: 'list' })
    const restart = service.createCommand(bindingId, 'service.restart', {})

    expect(service.runtime(bindingId)).toMatchObject({
      connected: true,
      hostname: 'game-1',
      capabilities: ['systemd', 'journald', 'rcon'],
    })
    expect(sent.map((message) => JSON.parse(message).type)).toEqual([
      'hello.accepted',
      'command',
    ])
    expect(store.getCommand(command.id)?.status).toBe('delivered')
    expect(store.getCommand(restart.id)?.status).toBe('queued')

    service.handle(socket, { type: 'command.ack', commandId: command.id })
    service.handle(socket, {
      type: 'command.completed',
      commandId: command.id,
      output: 'There are 2 of a max of 20 players online',
    })

    expect(sent.map((message) => JSON.parse(message).type)).toEqual([
      'hello.accepted',
      'command',
      'command',
    ])
    expect(store.getCommand(restart.id)?.status).toBe('delivered')

    expect(store.getCommand(command.id)).toMatchObject({
      status: 'succeeded',
      output: 'There are 2 of a max of 20 players online',
    })
    expect(store.listEvents(bindingId).map((event) => event.type)).toContain('command.succeeded')
  })

  test('deduplicates journal lines by cursor and marks disconnects', () => {
    const { bindingId, store, service } = harness()
    const sent: string[] = []
    const socket = { send: (message: unknown) => sent.push(String(message)), close: () => {} }
    service.handle(socket, {
      type: 'hello',
      token: 'valid-token',
      agentVersion: '0.1.0',
      hostname: 'game-1',
      capabilities: ['journald'],
    })
    const line = {
      cursor: 'cursor-1',
      createdAt: new Date().toISOString(),
      stream: 'stdout',
      message: 'Server started',
    }
    service.handle(socket, { type: 'log', line })
    service.handle(socket, { type: 'log', line })
    service.close(socket)

    expect(store.listEvents(bindingId).filter((event) => event.type === 'log.stdout')).toHaveLength(1)
    expect(sent.map((message) => JSON.parse(message)).filter((message) => message.type === 'log.ack')).toEqual([
      { type: 'log.ack', cursor: 'cursor-1' },
      { type: 'log.ack', cursor: 'cursor-1' },
    ])
    expect(service.runtime(bindingId).connected).toBe(false)
  })

  test('waits for a lifecycle command terminal result', async () => {
    const { bindingId, service } = harness()
    const socket = { send: () => {}, close: () => {} }
    service.handle(socket, {
      type: 'hello', token: 'valid-token', agentVersion: '0.2.0', hostname: 'game-1', capabilities: ['systemd'],
    })
    const command = service.createCommand(bindingId, 'service.start', {})
    const waiting = service.waitForCommand(command.id, new AbortController().signal)
    service.handle(socket, { type: 'command.ack', commandId: command.id })
    service.handle(socket, { type: 'command.completed', commandId: command.id, output: '' })
    expect((await waiting).status).toBe('succeeded')
  })

  test('correlates ephemeral live filesystem responses', async () => {
    const { bindingId, service } = harness()
    const sent: string[] = []
    const socket = { send: (message: unknown) => sent.push(String(message)), close: () => {} }
    service.handle(socket, {
      type: 'hello', token: 'valid-token', agentVersion: '0.2.0', hostname: 'game-1',
      capabilities: ['systemd', 'filesystem-v1'],
    })

    const pending = service.requestFilesystem(bindingId, 'list', { path: 'config' })
    const request = JSON.parse(sent.at(-1)!)
    expect(request).toMatchObject({
      type: 'fs.request',
      request: { bindingId, operation: 'list', path: 'config' },
    })
    service.handle(socket, {
      type: 'fs.response', requestId: request.request.id, ok: true,
      result: { path: 'config', entries: [] },
    })
    expect(await pending).toEqual({ path: 'config', entries: [] })
  })

  test('tracks an Elysia connection across wrappers that share one raw socket', () => {
    const { bindingId, service } = harness()
    const raw = {}
    const sent: string[] = []
    let closes = 0
    const wrapper = () => ({
      raw,
      send: (message: unknown) => sent.push(String(message)),
      close: () => { closes += 1 },
    })

    service.open(wrapper())
    service.handle(wrapper(), {
      type: 'hello',
      token: 'valid-token',
      agentVersion: '0.1.0',
      hostname: 'minecraft',
      capabilities: ['systemd', 'journald', 'rcon'],
    })
    service.handle(wrapper(), {
      type: 'status',
      runtime: {
        state: 'active',
        subState: 'running',
        mainPid: 49636,
        updatedAt: new Date().toISOString(),
      },
    })

    expect(closes).toBe(0)
    expect(service.runtime(bindingId)).toMatchObject({
      connected: true,
      runtime: { state: 'active', subState: 'running', mainPid: 49636 },
    })

    service.close(wrapper())
    expect(service.runtime(bindingId).connected).toBe(false)
  })
})
