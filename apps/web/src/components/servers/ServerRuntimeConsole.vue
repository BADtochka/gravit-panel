<template>
  <section class="space-y-4 border-t pt-4">
    <div class="flex flex-wrap items-start justify-between gap-3">
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
      <div class="flex flex-wrap gap-2">
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

    <div class="overflow-hidden rounded-md border bg-card">
      <div class="flex h-11 flex-wrap items-center justify-between gap-2 border-b px-3">
        <p class="text-xs font-medium">Realtime log</p>
        <div class="flex items-center gap-3">
          <div class="flex items-center gap-2">
            <Switch :id="autoScrollId" v-model="autoScroll" />
            <label class="text-xs text-muted-foreground" :for="autoScrollId">Auto-scroll</label>
          </div>
          <span class="flex items-center gap-1.5 text-xs text-muted-foreground">
            <span class="size-1.5 rounded-full" :class="streamStateClass" />
            {{ streamStateLabel }}
          </span>
        </div>
      </div>
      <div ref="logContainer" class="h-80 overflow-auto p-3 font-mono text-xs">
        <p v-if="!events.length" class="text-muted-foreground">Waiting for server events...</p>
        <div
          v-for="event in events"
          :key="event.sequence"
          class="grid grid-cols-[4.5rem_minmax(0,1fr)] gap-3 border-b py-1.5 last:border-0 sm:grid-cols-[4.5rem_7rem_minmax(0,1fr)]"
        >
          <span class="text-muted-foreground">{{ formatTime(event.createdAt) }}</span>
          <span class="hidden truncate font-medium sm:block">{{ event.type }}</span>
          <span class="whitespace-pre-wrap break-words">{{ event.message }}</span>
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
import { panelFetch, panelUrl } from '@/lib/public-path'
import type {
  ServerCommandType,
  ServerRuntimeEvent,
  ServerRuntimeState,
} from '@gravit-panel/shared'
import { useMutation, useQuery, useQueryClient } from '@tanstack/vue-query'
import { Play, RotateCw, Send, Square, TriangleAlert } from '@lucide/vue'
import { computed, onBeforeUnmount, ref, watch } from 'vue'

const props = defineProps<{
  installationId: string
  bindingId: string
  disabled: boolean
}>()
const queryClient = useQueryClient()
const events = ref<ServerRuntimeEvent[]>([])
const consoleCommand = ref('')
const commandHistory = ref<string[]>([])
const historyIndex = ref(0)
const streamState = ref<'connecting' | 'live' | 'reconnecting' | 'closed'>('connecting')
const { autoScroll, logContainer } = useLogAutoScroll(() => events.value.length)
let eventSource: EventSource | null = null
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
  refetchInterval: 5_000,
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
  },
  onSuccess: () => queryClient.invalidateQueries({ queryKey: runtimeQueryKey.value }),
})

const sendCommand = (type: ServerCommandType, payload: Record<string, unknown> = {}) => {
  commandMutation.mutate({ type, payload })
}
const executeConsoleCommand = () => {
  const command = consoleCommand.value.trim()
  if (!command) return
  sendCommand('console.execute', { command })
  commandHistory.value = [...commandHistory.value.filter((item) => item !== command), command].slice(-100)
  historyIndex.value = commandHistory.value.length
  consoleCommand.value = ''
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

const connect = () => {
  eventSource?.close()
  events.value = []
  seenSequences = new Set<number>()
  streamState.value = 'connecting'
  const query = `installationId=${encodeURIComponent(props.installationId)}`
  eventSource = new EventSource(panelUrl(`/api/servers/bindings/${props.bindingId}/events?${query}`))
  eventSource.onopen = () => {
    streamState.value = 'live'
  }
  eventSource.onerror = () => {
    streamState.value = 'reconnecting'
  }
  eventSource.addEventListener('server', (rawEvent) => {
    const event = JSON.parse((rawEvent as MessageEvent<string>).data) as ServerRuntimeEvent
    if (event.bindingId !== props.bindingId || seenSequences.has(event.sequence)) return
    seenSequences.add(event.sequence)
    events.value = [...events.value, event].slice(-2_000)
    if (seenSequences.size > 4_000) {
      seenSequences = new Set(events.value.map((item) => item.sequence))
    }
  })
}

watch(() => [props.installationId, props.bindingId], connect, { immediate: true })
onBeforeUnmount(() => {
  eventSource?.close()
  streamState.value = 'closed'
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
