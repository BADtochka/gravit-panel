import type {
  ServerCommand,
  ServerCommandStatus,
  ServerCommandType,
  ServerRuntimeEvent,
  ServerRuntimeState,
  ServerServiceRuntime,
} from '@gravit-panel/shared'
import type { Database } from 'bun:sqlite'

interface AgentRow {
  binding_id: string
  agent_version: string
  hostname: string
  capabilities_json: string
  runtime_json: string | null
  connected_at: string
  last_seen_at: string
}

interface CommandRow {
  id: string
  binding_id: string
  type: ServerCommandType
  payload_json: string
  status: ServerCommandStatus
  output: string | null
  error: string | null
  created_at: string
  delivered_at: string | null
  started_at: string | null
  finished_at: string | null
}

interface EventRow {
  sequence: number
  binding_id: string
  command_id: string | null
  type: string
  message: string
  created_at: string
}

const parseArray = (value: string) => {
  const parsed = JSON.parse(value) as unknown
  return Array.isArray(parsed)
    ? parsed.filter((item): item is string => typeof item === 'string')
    : []
}

const toCommand = (row: CommandRow): ServerCommand => ({
  id: row.id,
  bindingId: row.binding_id,
  type: row.type,
  payload: JSON.parse(row.payload_json) as Record<string, unknown>,
  status: row.status,
  output: row.output,
  error: row.error,
  createdAt: row.created_at,
  deliveredAt: row.delivered_at,
  startedAt: row.started_at,
  finishedAt: row.finished_at,
})

const toEvent = (row: EventRow): ServerRuntimeEvent => ({
  sequence: row.sequence,
  bindingId: row.binding_id,
  ...(row.command_id ? { commandId: row.command_id } : {}),
  type: row.type,
  message: row.message,
  createdAt: row.created_at,
})

export class ServerAgentStore {
  constructor(private readonly db: Database) {}

  saveAgent(
    bindingId: string,
    input: { agentVersion: string; hostname: string; capabilities: string[] },
  ) {
    const now = new Date().toISOString()
    this.db.query(`
      INSERT INTO server_agents (
        binding_id, agent_version, hostname, capabilities_json,
        runtime_json, connected_at, last_seen_at
      ) VALUES (?, ?, ?, ?, NULL, ?, ?)
      ON CONFLICT(binding_id) DO UPDATE SET
        agent_version = excluded.agent_version,
        hostname = excluded.hostname,
        capabilities_json = excluded.capabilities_json,
        connected_at = excluded.connected_at,
        last_seen_at = excluded.last_seen_at
    `).run(
      bindingId,
      input.agentVersion,
      input.hostname,
      JSON.stringify(input.capabilities),
      now,
      now,
    )
  }

  touch(bindingId: string) {
    this.db.query('UPDATE server_agents SET last_seen_at = ? WHERE binding_id = ?')
      .run(new Date().toISOString(), bindingId)
  }

  saveRuntime(bindingId: string, runtime: ServerServiceRuntime) {
    this.db.query(`
      UPDATE server_agents SET runtime_json = ?, last_seen_at = ? WHERE binding_id = ?
    `).run(JSON.stringify(runtime), new Date().toISOString(), bindingId)
  }

  runtime(bindingId: string, connected: boolean): ServerRuntimeState {
    const row = this.db.query<AgentRow, [string]>(
      'SELECT * FROM server_agents WHERE binding_id = ?',
    ).get(bindingId)
    return {
      bindingId,
      connected,
      agentVersion: row?.agent_version ?? null,
      hostname: row?.hostname ?? null,
      capabilities: row ? parseArray(row.capabilities_json) : [],
      lastSeenAt: row?.last_seen_at ?? null,
      runtime: row?.runtime_json
        ? JSON.parse(row.runtime_json) as ServerServiceRuntime
        : null,
    }
  }

  createCommand(
    bindingId: string,
    type: ServerCommandType,
    payload: Record<string, unknown>,
  ) {
    const command: ServerCommand = {
      id: crypto.randomUUID(),
      bindingId,
      type,
      payload,
      status: 'queued',
      output: null,
      error: null,
      createdAt: new Date().toISOString(),
      deliveredAt: null,
      startedAt: null,
      finishedAt: null,
    }
    this.db.query(`
      INSERT INTO server_commands (
        id, binding_id, type, payload_json, status, created_at
      ) VALUES (?, ?, ?, ?, 'queued', ?)
    `).run(command.id, bindingId, type, JSON.stringify(payload), command.createdAt)
    return command
  }

  getCommand(id: string) {
    const row = this.db.query<CommandRow, [string]>(
      'SELECT * FROM server_commands WHERE id = ?',
    ).get(id)
    return row ? toCommand(row) : null
  }

  pendingCommands(bindingId: string) {
    return this.db.query<CommandRow, [string]>(`
      SELECT * FROM server_commands
      WHERE binding_id = ? AND status = 'queued'
      ORDER BY created_at ASC
    `).all(bindingId).map(toCommand)
  }

  activeCommand(bindingId: string) {
    const row = this.db.query<CommandRow, [string]>(`
      SELECT * FROM server_commands
      WHERE binding_id = ? AND status IN ('delivered', 'running')
      ORDER BY created_at ASC LIMIT 1
    `).get(bindingId)
    return row ? toCommand(row) : null
  }

  requeueActive(bindingId?: string) {
    const clause = bindingId ? ' AND binding_id = ?' : ''
    const query = this.db.query(`
      UPDATE server_commands
      SET status = 'queued', delivered_at = NULL
      WHERE status IN ('delivered', 'running')${clause}
    `)
    if (bindingId) query.run(bindingId)
    else query.run()
  }

  markDelivered(id: string) {
    this.db.query(`
      UPDATE server_commands
      SET status = 'delivered', delivered_at = ?
      WHERE id = ? AND status = 'queued'
    `).run(new Date().toISOString(), id)
    return this.getCommand(id)
  }

  markRunning(id: string) {
    this.db.query(`
      UPDATE server_commands
      SET status = 'running', started_at = COALESCE(started_at, ?)
      WHERE id = ? AND status IN ('queued', 'delivered')
    `).run(new Date().toISOString(), id)
    return this.getCommand(id)
  }

  finishCommand(id: string, output?: string, error?: string) {
    this.db.query(`
      UPDATE server_commands SET status = ?, output = ?, error = ?,
        started_at = COALESCE(started_at, ?), finished_at = ?
      WHERE id = ? AND status NOT IN ('succeeded', 'failed')
    `).run(
      error ? 'failed' : 'succeeded',
      output?.slice(0, 65_536) ?? null,
      error?.slice(0, 4000) ?? null,
      new Date().toISOString(),
      new Date().toISOString(),
      id,
    )
    return this.getCommand(id)
  }

  appendEvent(
    bindingId: string,
    type: string,
    message: string,
    commandId?: string,
    cursor?: string,
    createdAt = new Date().toISOString(),
  ): ServerRuntimeEvent | null {
    const result = this.db.query(`
      INSERT OR IGNORE INTO server_runtime_events (
        binding_id, command_id, type, message, cursor, created_at
      ) VALUES (?, ?, ?, ?, ?, ?)
    `).run(
      bindingId,
      commandId ?? null,
      type.slice(0, 64),
      message.slice(0, 16_384),
      cursor?.slice(0, 2000) || null,
      createdAt,
    )
    if (!result.changes) return null

    const event: ServerRuntimeEvent = {
      sequence: Number(result.lastInsertRowid),
      bindingId,
      ...(commandId ? { commandId } : {}),
      type: type.slice(0, 64),
      message: message.slice(0, 16_384),
      createdAt,
    }
    this.db.query(`
      DELETE FROM server_runtime_events
      WHERE binding_id = ? AND sequence NOT IN (
        SELECT sequence FROM server_runtime_events
        WHERE binding_id = ? ORDER BY sequence DESC LIMIT 2000
      )
    `).run(bindingId, bindingId)
    return event
  }

  listEvents(bindingId: string, afterSequence = 0) {
    return this.db.query<EventRow, [string, number]>(`
      SELECT sequence, binding_id, command_id, type, message, created_at
      FROM server_runtime_events
      WHERE binding_id = ? AND sequence > ?
      ORDER BY sequence ASC
    `).all(bindingId, afterSequence).map(toEvent)
  }
}
