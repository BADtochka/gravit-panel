import type {
  ServerCommandType,
  ServerServiceRuntime,
} from '@gravit-panel/shared'
import type { ServerAgentEventHub } from './server-agent.events'
import type { ServerAgentStore } from './server-agent.store'

interface AgentSocket {
  send(data: unknown): unknown
  close?: () => unknown
  raw?: object
}

interface AgentHello {
  type: 'hello'
  token: string
  agentVersion: string
  hostname: string
  capabilities: string[]
}

interface PendingFilesystemRequest {
  bindingId: string
  socketKey: object
  resolve: (value: unknown) => void
  reject: (error: Error) => void
  timer: ReturnType<typeof setTimeout>
}

const commandTypes = new Set<ServerCommandType>([
  'service.start',
  'service.stop',
  'service.restart',
  'console.execute',
])

export class ServerAgentService {
  private readonly sockets = new Map<string, AgentSocket>()
  private readonly bindings = new WeakMap<object, string>()
  private readonly helloTimers = new WeakMap<object, ReturnType<typeof setTimeout>>()
  private readonly pendingSockets = new Set<object>()
  private readonly pendingFilesystem = new Map<string, PendingFilesystemRequest>()

  constructor(
    private readonly store: ServerAgentStore,
    private readonly events: ServerAgentEventHub,
    private readonly authenticate: (token: string) => { id: string } | null,
  ) {
    this.store.requeueActive()
  }

  open(socket: AgentSocket) {
    const socketKey = this.socketKey(socket)
    if (this.pendingSockets.size >= 100) {
      socket.close?.()
      return
    }
    this.pendingSockets.add(socketKey)
    const timer = setTimeout(() => {
      this.pendingSockets.delete(socketKey)
      if (!this.bindings.has(socketKey)) socket.close?.()
    }, 5000)
    this.helloTimers.set(socketKey, timer)
  }

  isConnected(bindingId: string) {
    return this.sockets.has(bindingId)
  }

  runtime(bindingId: string) {
    return this.store.runtime(bindingId, this.isConnected(bindingId))
  }

  createCommand(bindingId: string, type: ServerCommandType, payload: Record<string, unknown>) {
    if (!commandTypes.has(type)) throw new Error('Unsupported server command type')
    if (type === 'console.execute') {
      const command = payload.command
      if (typeof command !== 'string' || !command.trim() || command.length > 1000) {
        throw new Error('Console command must be between 1 and 1000 characters')
      }
      if (/[\u0000-\u0008\u000b-\u001f\u007f\r\n]/.test(command)) {
        throw new Error('Console command contains unsupported control characters')
      }
      payload = { command: command.trim() }
    } else {
      payload = {}
    }
    const command = this.store.createCommand(bindingId, type, payload)
    this.publish(bindingId, 'command.queued', type, command.id)
    this.dispatchNext(bindingId)
    return command
  }

  async waitForCommand(commandId: string, signal: AbortSignal) {
    const deadline = Date.now() + 2 * 60_000
    while (Date.now() < deadline) {
      signal.throwIfAborted()
      const command = this.store.getCommand(commandId)
      if (!command) throw new Error('Server command no longer exists')
      if (command.status === 'succeeded') return command
      if (command.status === 'failed') throw new Error(command.error ?? 'Server command failed')
      await Bun.sleep(100)
    }
    throw new Error('Server command timed out')
  }

  requestFilesystem(
    bindingId: string,
    operation: string,
    payload: Record<string, unknown>,
    timeoutMs = 30_000,
  ) {
    const socket = this.sockets.get(bindingId)
    const runtime = this.store.runtime(bindingId, Boolean(socket))
    if (!socket) return Promise.reject(new Error('Host agent is offline'))
    if (!runtime.capabilities.includes('filesystem-v1')) {
      return Promise.reject(new Error('Host agent does not support live files'))
    }
    const id = crypto.randomUUID()
    const socketKey = this.socketKey(socket)
    return new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingFilesystem.delete(id)
        reject(new Error('Live filesystem request timed out'))
      }, timeoutMs)
      this.pendingFilesystem.set(id, { bindingId, socketKey, resolve, reject, timer })
      try {
        socket.send(JSON.stringify({
          type: 'fs.request',
          request: { id, bindingId, operation, ...payload },
        }))
      } catch (error) {
        clearTimeout(timer)
        this.pendingFilesystem.delete(id)
        reject(error instanceof Error ? error : new Error(String(error)))
      }
    })
  }

  handle(socket: AgentSocket, raw: unknown) {
    const message = this.parse(raw)
    if (!message || typeof message.type !== 'string') return
    if (message.type === 'hello') {
      this.hello(socket, message as unknown as AgentHello)
      return
    }
    const bindingId = this.bindings.get(this.socketKey(socket))
    if (!bindingId) {
      socket.close?.()
      return
    }
    this.store.touch(bindingId)
    switch (message.type) {
      case 'heartbeat':
        return
      case 'status':
        return this.status(bindingId, message.runtime)
      case 'log':
        return this.log(socket, bindingId, message.line)
      case 'command.ack':
        return this.ack(bindingId, message.commandId)
      case 'command.completed':
        return this.complete(bindingId, message.commandId, message.output)
      case 'command.failed':
        return this.fail(bindingId, message.commandId, message.error)
      case 'fs.response':
        return this.filesystemResponse(socket, bindingId, message)
    }
  }

  close(socket: AgentSocket) {
    const socketKey = this.socketKey(socket)
    const timer = this.helloTimers.get(socketKey)
    if (timer) clearTimeout(timer)
    this.helloTimers.delete(socketKey)
    this.pendingSockets.delete(socketKey)
    const bindingId = this.bindings.get(socketKey)
    if (!bindingId) return
    this.bindings.delete(socketKey)
    const activeSocket = this.sockets.get(bindingId)
    if (!activeSocket || this.socketKey(activeSocket) !== socketKey) return
    this.sockets.delete(bindingId)
    for (const [id, pending] of this.pendingFilesystem) {
      if (pending.socketKey !== socketKey) continue
      clearTimeout(pending.timer)
      this.pendingFilesystem.delete(id)
      pending.reject(new Error('Host agent disconnected during filesystem request'))
    }
    this.store.requeueActive(bindingId)
    this.publish(bindingId, 'agent.disconnected', 'Host agent disconnected')
  }

  private hello(socket: AgentSocket, message: AgentHello) {
    if (
      typeof message.token !== 'string' ||
      typeof message.agentVersion !== 'string' ||
      typeof message.hostname !== 'string' ||
      !Array.isArray(message.capabilities)
    ) {
      socket.close?.()
      return
    }
    const binding = this.authenticate(message.token)
    if (!binding) {
      socket.close?.()
      return
    }
    const previous = this.sockets.get(binding.id)
    if (previous && this.socketKey(previous) !== this.socketKey(socket)) previous.close?.()
    this.sockets.set(binding.id, socket)
    const socketKey = this.socketKey(socket)
    this.bindings.set(socketKey, binding.id)
    const timer = this.helloTimers.get(socketKey)
    if (timer) clearTimeout(timer)
    this.helloTimers.delete(socketKey)
    this.pendingSockets.delete(socketKey)
    this.store.saveAgent(binding.id, {
      agentVersion: message.agentVersion.slice(0, 64),
      hostname: message.hostname.slice(0, 253),
      capabilities: message.capabilities
        .filter((item): item is string => typeof item === 'string')
        .slice(0, 32),
    })
    socket.send(JSON.stringify({ type: 'hello.accepted', bindingId: binding.id }))
    this.publish(binding.id, 'agent.connected', `Host agent connected from ${message.hostname}`)
    this.dispatchNext(binding.id)
  }

  private status(bindingId: string, value: unknown) {
    if (!value || typeof value !== 'object') return
    const runtime = value as Partial<ServerServiceRuntime>
    if (
      typeof runtime.state !== 'string' ||
      typeof runtime.subState !== 'string' ||
      typeof runtime.mainPid !== 'number' ||
      typeof runtime.updatedAt !== 'string'
    ) return
    this.store.saveRuntime(bindingId, {
      state: runtime.state.slice(0, 64),
      subState: runtime.subState.slice(0, 64),
      mainPid: Math.max(0, Math.trunc(runtime.mainPid)),
      updatedAt: runtime.updatedAt,
    })
  }

  private log(socket: AgentSocket, bindingId: string, value: unknown) {
    if (!value || typeof value !== 'object') return
    const line = value as Record<string, unknown>
    if (typeof line.message !== 'string') return
    this.publish(
      bindingId,
      typeof line.stream === 'string' ? `log.${line.stream.slice(0, 32)}` : 'log.stdout',
      line.message,
      undefined,
      typeof line.cursor === 'string' ? line.cursor : undefined,
      typeof line.createdAt === 'string' ? line.createdAt : undefined,
    )
    if (typeof line.cursor === 'string' && line.cursor) {
      socket.send(JSON.stringify({ type: 'log.ack', cursor: line.cursor }))
    }
  }

  private ack(bindingId: string, commandId: unknown) {
    if (typeof commandId !== 'string') return
    const command = this.store.getCommand(commandId)
    if (!command || command.bindingId !== bindingId) return
    this.store.markRunning(commandId)
    this.publish(bindingId, 'command.running', command.type, commandId)
  }

  private complete(bindingId: string, commandId: unknown, output: unknown) {
    if (typeof commandId !== 'string') return
    const command = this.store.getCommand(commandId)
    if (!command || command.bindingId !== bindingId) return
    const text = typeof output === 'string' ? output : ''
    this.store.finishCommand(commandId, text)
    if (text) this.publish(bindingId, 'command.output', text, commandId)
    this.publish(bindingId, 'command.succeeded', command.type, commandId)
    this.dispatchNext(bindingId)
  }

  private fail(bindingId: string, commandId: unknown, error: unknown) {
    if (typeof commandId !== 'string') return
    const command = this.store.getCommand(commandId)
    if (!command || command.bindingId !== bindingId) return
    const message = typeof error === 'string' ? error : 'Agent command failed'
    this.store.finishCommand(commandId, undefined, message)
    this.publish(bindingId, 'command.failed', message, commandId)
    this.dispatchNext(bindingId)
  }

  private filesystemResponse(
    socket: AgentSocket,
    bindingId: string,
    message: Record<string, unknown>,
  ) {
    if (typeof message.requestId !== 'string') return
    const pending = this.pendingFilesystem.get(message.requestId)
    if (
      !pending ||
      pending.bindingId !== bindingId ||
      pending.socketKey !== this.socketKey(socket)
    ) return
    clearTimeout(pending.timer)
    this.pendingFilesystem.delete(message.requestId)
    if (message.ok === true) {
      pending.resolve(message.result)
      return
    }
    const error = message.error
    const text = error && typeof error === 'object' && 'message' in error && typeof error.message === 'string'
      ? error.message
      : 'Live filesystem request failed'
    pending.reject(new Error(text))
  }

  private dispatchNext(bindingId: string) {
    const socket = this.sockets.get(bindingId)
    if (!socket || this.store.activeCommand(bindingId)) return
    const command = this.store.pendingCommands(bindingId)[0]
    if (!command) return
    if (Date.now() - Date.parse(command.createdAt) > 5 * 60_000) {
      this.store.finishCommand(command.id, undefined, 'Command expired before delivery')
      this.publish(bindingId, 'command.failed', 'Command expired before delivery', command.id)
      this.dispatchNext(bindingId)
      return
    }
    try {
      socket.send(JSON.stringify({ type: 'command', command: {
        id: command.id,
        bindingId: command.bindingId,
        type: command.type,
        payload: command.payload,
        createdAt: command.createdAt,
      } }))
      this.store.markDelivered(command.id)
      this.publish(bindingId, 'command.delivered', command.type, command.id)
    } catch {
      this.close(socket)
    }
  }

  private publish(
    bindingId: string,
    type: string,
    message: string,
    commandId?: string,
    cursor?: string,
    createdAt?: string,
  ) {
    this.events.publish(this.store.appendEvent(
      bindingId,
      type,
      message,
      commandId,
      cursor,
      createdAt,
    ))
  }

  private parse(raw: unknown): Record<string, unknown> | null {
    if (raw && typeof raw === 'object') return raw as Record<string, unknown>
    if (typeof raw !== 'string') return null
    try {
      const parsed = JSON.parse(raw) as unknown
      return parsed && typeof parsed === 'object' ? parsed as Record<string, unknown> : null
    } catch {
      return null
    }
  }

  private socketKey(socket: AgentSocket) {
    return socket.raw ?? socket as object
  }
}
