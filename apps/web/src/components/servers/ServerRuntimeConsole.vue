<template>
  <section class="space-y-5">
    <div class="flex min-h-16 flex-col justify-between gap-3 sm:flex-row sm:items-start">
      <div>
        <div class="flex items-center gap-2">
          <h4 class="text-sm font-semibold">Server runtime</h4>
          <Badge :variant="serviceRunning ? 'secondary' : 'outline'">
            {{ runtimeStatus }}
          </Badge>
        </div>
        <p class="mt-1 text-xs text-muted-foreground">
          {{ runtimeSummary }}
        </p>
      </div>
      <div class="grid grid-cols-3 gap-2 sm:flex">
        <Button
          size="sm"
          type="button"
          variant="outline"
          :disabled="disabled || commandPending || !agentConnected || serviceRunning || serviceStarting"
          @click="sendCommand('service.start')"
        >
          <Play class="size-4" />
          Start
        </Button>
        <Button
          size="sm"
          type="button"
          variant="outline"
          :disabled="disabled || commandPending || !agentConnected || serviceStopped || serviceStopping"
          @click="sendCommand('service.stop')"
        >
          <Square class="size-4" />
          Stop
        </Button>
        <Button
          size="sm"
          type="button"
          variant="outline"
          :disabled="disabled || commandPending || !agentConnected || !serviceRunning"
          @click="sendCommand('service.restart')"
        >
          <RotateCw class="size-4" />
          Restart
        </Button>
      </div>
    </div>

    <Alert v-if="error" variant="destructive">
      <TriangleAlert class="size-4" />
      <AlertTitle>Server runtime operation failed</AlertTitle>
      <AlertDescription>{{ error.message }}</AlertDescription>
    </Alert>

    <form class="flex gap-2" @submit.prevent="executeConsoleCommand">
      <Input
        :id="consoleInputId"
        v-model="consoleCommand"
        autocomplete="off"
        placeholder="Enter a server command..."
        :disabled="disabled || commandPending || !agentConnected || !serviceRunning"
        @keydown.down.prevent="showNewerCommand"
        @keydown.up.prevent="showOlderCommand"
      />
      <Button
        type="submit"
        :disabled="disabled || commandPending || !agentConnected || !serviceRunning || !consoleCommand.trim()"
      >
        <Send class="size-4" />
        Send
      </Button>
    </form>

    <div class="overflow-hidden rounded-lg border border-zinc-800 bg-zinc-950 text-zinc-200 shadow-inner">
      <div class="flex min-h-11 flex-wrap items-center justify-between gap-2 border-b border-zinc-800 px-3 py-2">
        <p class="flex items-center gap-2 text-xs font-medium text-zinc-300">
          <TerminalSquare class="size-3.5" /> Realtime log
        </p>
        <div class="flex items-center gap-3">
          <div class="flex items-center gap-2">
            <Switch :id="agentLogsId" v-model="showAgentLogs" />
            <label class="text-xs text-zinc-400" :for="agentLogsId">Agent logs</label>
          </div>
          <div class="flex items-center gap-2">
            <Switch :id="autoScrollId" v-model="autoScroll" />
            <label class="text-xs text-zinc-400" :for="autoScrollId">Auto-scroll</label>
          </div>
          <span class="flex items-center gap-1.5 text-xs text-zinc-400">
            <span class="size-1.5 rounded-full" :class="streamStateClass" />
            {{ streamStateLabel }}
          </span>
        </div>
      </div>
      <div ref="logContainer" class="h-[26rem] overflow-auto p-3 font-mono text-[11px] leading-5 sm:h-[32rem] sm:text-xs">
        <p v-if="!visibleEvents.length" class="text-zinc-500">Waiting for server events...</p>
        <div
          v-for="event in visibleEvents"
          :key="event.sequence"
          class="grid grid-cols-[4.5rem_minmax(0,1fr)] gap-2 border-b border-zinc-900 py-1 last:border-0 sm:grid-cols-[4.5rem_7rem_minmax(0,1fr)]"
        >
          <span class="text-zinc-400">{{ formatTime(event.createdAt) }}</span>
          <span class="hidden truncate text-zinc-400 sm:block">{{ event.type }}</span>
          <span class="whitespace-pre-wrap break-words text-zinc-200">{{ event.message }}</span>
        </div>
      </div>
    </div>
  </section>
</template>

<script setup lang="ts">
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Switch } from '@/components/ui/switch'
import { useLogAutoScroll } from '@/composables/useLogAutoScroll'
import { panelFetch, panelWebSocketUrl } from '@/lib/public-path'
import type {
  JobRecord,
  ServerCommand,
  ServerCommandType,
  ServerRuntimeEvent,
  ServerRuntimeState,
} from '@gravit-panel/shared'
import { useMutation, useQuery, useQueryClient } from '@tanstack/vue-query'
import { Play, RotateCw, Send, Square, TerminalSquare, TriangleAlert } from '@lucide/vue'
import { computed, onBeforeUnmount, ref, watch } from 'vue'

const props = defineProps<{
  installationId: string
  bindingId: string
  disabled: boolean
  active: boolean
}>()
const emit = defineEmits<{ job: [job: JobRecord] }>()
const queryClient = useQueryClient()
const events = ref<ServerRuntimeEvent[]>([])
const showAgentLogs = ref(false)
const technicalEventTypes = new Set([
  'agent.connected',
  'agent.disconnected',
  'command.queued',
  'command.delivered',
  'command.running',
  'command.succeeded',
])
const isRconLifecycleEvent = (event: ServerRuntimeEvent) =>
  event.type === 'log.stdout' &&
  event.message.includes('Thread RCON Client /') &&
  (event.message.endsWith(' started') || event.message.endsWith(' shutting down'))
const visibleEvents = computed(() =>
  showAgentLogs.value
    ? events.value
    : events.value.filter((event) =>
        !technicalEventTypes.has(event.type) && !isRconLifecycleEvent(event)),
)
const consoleCommand = ref('')
const commandHistory = ref<string[]>([])
const historyIndex = ref(0)
const streamState = ref<'connecting' | 'live' | 'reconnecting' | 'closed'>('connecting')
const { autoScroll, logContainer, scrollToLatest } = useLogAutoScroll(
  () => visibleEvents.value.at(-1)?.sequence ?? 0,
)
let eventSocket: WebSocket | null = null
let heartbeatTimer: ReturnType<typeof setInterval> | null = null
let reconnectTimer: ReturnType<typeof setTimeout> | null = null
let reconnectAttempt = 0
let connectionGeneration = 0
let flushFrame: number | null = null
let pendingEvents: ServerRuntimeEvent[] = []
let seenSequences = new Set<number>()

const getJson = async <T>(path: string): Promise<T> => {
  const response = await panelFetch(path)
  if (!response.ok) {
    const body = (await response.json().catch(() => null)) as { message?: string } | null
    throw new Error(body?.message ?? `Request failed with status ${response.status}`)
  }
  return response.json() as Promise<T>
}

const runtimeQueryKey = computed(
  () => ['server-runtime', props.installationId, props.bindingId],
)
const {
  data: runtime,
  error: runtimeError,
} = useQuery({
  queryKey: runtimeQueryKey,
  queryFn: () => getJson<ServerRuntimeState>(
    `/api/servers/bindings/${props.bindingId}/runtime?installationId=${encodeURIComponent(props.installationId)}`,
  ),
  enabled: computed(() => props.active),
  refetchInterval: computed(() =>
    props.active && (streamState.value === 'reconnecting' || streamState.value === 'closed')
      ? 5_000
      : false,
  ),
})

const commandMutation = useMutation({
  mutationFn: async ({ type, payload }: { type: ServerCommandType; payload: Record<string, unknown> }) => {
    const response = await panelFetch(`/api/servers/bindings/${props.bindingId}/commands`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ installationId: props.installationId, type, payload }),
    })
    if (!response.ok) {
      const body = (await response.json().catch(() => null)) as { message?: string } | null
      throw new Error(body?.message ?? `Request failed with status ${response.status}`)
    }
    return response.json() as Promise<JobRecord | ServerCommand>
  },
  onSuccess: (result, variables) => {
    if ('progress' in result) emit('job', result)
    if (variables.type === 'console.execute') consoleCommand.value = ''
    void queryClient.invalidateQueries({ queryKey: runtimeQueryKey.value })
  },
})

const sendCommand = (type: ServerCommandType, payload: Record<string, unknown> = {}) => {
  commandMutation.mutate({ type, payload })
}
const executeConsoleCommand = () => {
  const command = consoleCommand.value.trim()
  if (!command) return
  scrollToLatest()
  sendCommand('console.execute', { command })
  commandHistory.value = [...commandHistory.value.filter((item) => item !== command), command].slice(-100)
  historyIndex.value = commandHistory.value.length
}
const showOlderCommand = () => {
  if (!commandHistory.value.length) return
  historyIndex.value = Math.max(0, historyIndex.value - 1)
  consoleCommand.value = commandHistory.value[historyIndex.value] ?? ''
}
const showNewerCommand = () => {
  if (!commandHistory.value.length) return
  historyIndex.value = Math.min(commandHistory.value.length, historyIndex.value + 1)
  consoleCommand.value = commandHistory.value[historyIndex.value] ?? ''
}

const applyHistory = (history: ServerRuntimeEvent[]) => {
  const next = history
    .filter((event) => event.bindingId === props.bindingId)
    .sort((left, right) => left.sequence - right.sequence)
    .slice(-500)
  events.value = next
  seenSequences = new Set(next.map((event) => event.sequence))
}

const flushPendingEvents = () => {
  flushFrame = null
  if (!pendingEvents.length) return
  events.value = [...events.value, ...pendingEvents]
    .sort((left, right) => left.sequence - right.sequence)
    .slice(-500)
  pendingEvents = []
  seenSequences = new Set(events.value.map((event) => event.sequence))
}

const enqueueEvent = (event: ServerRuntimeEvent) => {
  if (event.bindingId !== props.bindingId || seenSequences.has(event.sequence)) return
  seenSequences.add(event.sequence)
  pendingEvents.push(event)
  if (flushFrame === null) flushFrame = requestAnimationFrame(flushPendingEvents)
}

const clearSocket = () => {
  if (heartbeatTimer) clearInterval(heartbeatTimer)
  if (reconnectTimer) clearTimeout(reconnectTimer)
  heartbeatTimer = null
  reconnectTimer = null
  const socket = eventSocket
  eventSocket = null
  if (socket && socket.readyState < WebSocket.CLOSING) socket.close(1000, 'Console hidden')
}

const connect = () => {
  connectionGeneration += 1
  const generation = connectionGeneration
  clearSocket()
  events.value = []
  pendingEvents = []
  seenSequences = new Set<number>()
  streamState.value = 'connecting'
  const query = `installationId=${encodeURIComponent(props.installationId)}`
  const socket = new WebSocket(panelWebSocketUrl(
    `/api/servers/bindings/${props.bindingId}/events/ws?${query}`,
  ))
  eventSocket = socket
  socket.onopen = () => {
    if (generation !== connectionGeneration) return
    reconnectAttempt = 0
    streamState.value = 'live'
    heartbeatTimer = setInterval(() => {
      if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ type: 'ping' }))
    }, 20_000)
  }
  socket.onmessage = (rawEvent) => {
    if (generation !== connectionGeneration || typeof rawEvent.data !== 'string') return
    try {
      const message = JSON.parse(rawEvent.data) as {
        type?: string
        events?: ServerRuntimeEvent[]
        event?: ServerRuntimeEvent
      }
      if (message.type === 'history' && Array.isArray(message.events)) {
        applyHistory(message.events)
      } else if (message.type === 'event' && message.event) {
        enqueueEvent(message.event)
      }
    } catch {
      // Ignore malformed frames without tearing down the console.
    }
  }
  socket.onerror = () => socket.close()
  socket.onclose = () => {
    if (generation !== connectionGeneration || !props.active) return
    if (heartbeatTimer) clearInterval(heartbeatTimer)
    heartbeatTimer = null
    streamState.value = 'reconnecting'
    const delay = Math.min(15_000, 1000 * 2 ** reconnectAttempt)
    reconnectAttempt += 1
    reconnectTimer = setTimeout(connect, delay)
  }
}

const disconnect = () => {
  connectionGeneration += 1
  clearSocket()
  if (flushFrame !== null) cancelAnimationFrame(flushFrame)
  flushFrame = null
  pendingEvents = []
  streamState.value = 'closed'
}

watch(
  () => [props.installationId, props.bindingId, props.active] as const,
  ([, , active]) => active ? connect() : disconnect(),
  { immediate: true },
)
onBeforeUnmount(() => {
  disconnect()
})

const runtimeStatus = computed(() => {
  if (runtime.value && !runtime.value.connected) return 'Disconnected'
  const status = runtime.value?.runtime?.state ?? 'unknown'
  return status.charAt(0).toUpperCase() + status.slice(1)
})
const runtimeSummary = computed(() => {
  if (!runtime.value) return 'Loading service status...'
  if (!runtime.value.connected) {
    return runtime.value.lastSeenAt
      ? `Agent offline · last seen ${new Date(runtime.value.lastSeenAt).toLocaleString()}`
      : 'Agent has not connected yet.'
  }
  const serviceState = runtime.value.runtime?.subState ?? 'Service state unavailable'
  const process = runtime.value.runtime?.mainPid ? `PID ${runtime.value.runtime.mainPid}` : ''
  return [runtime.value.hostname, serviceState, process].filter(Boolean).join(' · ')
})
const agentConnected = computed(() => runtime.value?.connected ?? false)
const serviceRunning = computed(() => runtime.value?.runtime?.state === 'active')
const serviceStarting = computed(() => runtime.value?.runtime?.state === 'activating')
const serviceStopping = computed(() => runtime.value?.runtime?.state === 'deactivating')
const serviceStopped = computed(
  () => runtime.value?.runtime?.state === 'inactive' || runtime.value?.runtime?.state === 'failed',
)
const commandPending = computed(() => commandMutation.isPending.value)
const error = computed(() => (runtimeError.value || commandMutation.error.value) as Error | null)
const safeBindingId = computed(() => props.bindingId.replace(/[^a-zA-Z0-9_-]/g, '-'))
const consoleInputId = computed(() => `server-console-command-${safeBindingId.value}`)
const agentLogsId = computed(() => `server-console-agent-logs-${safeBindingId.value}`)
const autoScrollId = computed(() => `server-console-auto-scroll-${safeBindingId.value}`)
const streamStateLabel = computed(() => ({
  connecting: 'Connecting',
  live: 'Live',
  reconnecting: 'Reconnecting',
  closed: 'Closed',
})[streamState.value])
const streamStateClass = computed(() => ({
  connecting: 'bg-amber-500',
  live: 'bg-emerald-500',
  reconnecting: 'bg-amber-500',
  closed: 'bg-muted-foreground',
})[streamState.value])
const formatTime = (value: string) => new Intl.DateTimeFormat(undefined, {
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
}).format(new Date(value))
</script>
