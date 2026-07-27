<template>
  <section class="space-y-4 rounded-lg border bg-card p-4 md:p-6">
    <div class="flex flex-wrap items-start justify-between gap-3">
      <div>
        <p class="text-xs font-medium uppercase tracking-wide text-muted-foreground">HTTP transport</p>
        <h3 class="mt-1 text-lg font-semibold">RemoteControl</h3>
        <p class="mt-1 text-sm text-muted-foreground">
          Install the module with a token restricted to serverStatus and securitycheck.
        </p>
      </div>
      <span
        class="rounded-md px-2 py-1 text-xs font-medium"
        :class="
          configured
            ? 'bg-emerald-100 text-emerald-800 dark:bg-emerald-950 dark:text-emerald-300'
            : 'bg-muted text-muted-foreground'
        "
      >
        {{ configured ? 'Configured' : 'Not configured' }}
      </span>
    </div>

    <Alert v-if="configuration && !configuration.encryptionConfigured">
      <KeyRound class="size-4" />
      <AlertTitle>Credential encryption key required</AlertTitle>
      <AlertDescription class="flex flex-wrap items-center justify-between gap-3">
        <span>
          Generate a persistent AES-256 key before configuring RemoteControl. It is stored locally
          with mode 0600 and is never returned to the browser.
        </span>
        <Button
          size="sm"
          type="button"
          :disabled="keyPending || !configuration.canGenerateEncryptionKey"
          @click="generateEncryptionKey()"
        >
          <LoaderCircle v-if="keyPending" class="animate-spin" />
          <KeyRound v-else />
          Generate key
        </Button>
      </AlertDescription>
    </Alert>

    <form class="grid gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_auto]" @submit.prevent="startSetup">
      <label class="block text-sm font-medium">
        RemoteControl base URL
        <Input
          v-model.trim="endpoint"
          class="mt-1"
          type="url"
          maxlength="2048"
          placeholder="http://localhost:17549"
          required
        />
      </label>
      <div class="flex items-start gap-2 self-end rounded-md border p-3 text-sm">
        <Checkbox
          id="replace-remote-control-token"
          class="mt-0.5"
          :model-value="confirmed"
          @update:model-value="confirmed = $event === true"
        />
        <label class="cursor-pointer" for="replace-remote-control-token">
          Replace all existing RemoteControl tokens with one restricted panel token.
        </label>
      </div>
      <Button
        class="self-end"
        type="submit"
        :disabled="
          isPending ||
          !confirmed ||
          !configuration?.encryptionConfigured ||
          Boolean(job && !terminal)
        "
      >
        <LoaderCircle v-if="isPending || (job && !terminal)" class="size-4 animate-spin" />
        <KeyRound v-else class="size-4" />
        {{ configured ? 'Rotate token' : 'Configure' }}
      </Button>
    </form>

    <p
      v-if="queryError || mutationError || keyError"
      class="rounded-md border border-destructive/30 bg-destructive/5 p-3 text-sm text-destructive"
    >
      {{ (queryError || mutationError || keyError)?.message }}
    </p>

    <div v-if="job" class="overflow-hidden rounded-md border">
      <div class="flex items-center justify-between border-b px-4 py-2">
        <p class="text-sm font-medium">RemoteControl setup</p>
        <div class="flex items-center gap-2">
          <div class="flex items-center gap-2">
            <Switch id="remote-control-auto-scroll" v-model="autoScroll" />
            <label class="text-xs text-muted-foreground" for="remote-control-auto-scroll">
              Auto-scroll
            </label>
          </div>
          <span class="font-mono text-xs text-muted-foreground">{{ job.id.slice(0, 8) }}</span>
        </div>
      </div>
      <div class="h-1.5 bg-muted">
        <div
          class="h-full transition-[width]"
          :class="job.status === 'failed' ? 'bg-red-600' : 'bg-foreground'"
          :style="{ width: `${job.progress}%` }"
        />
      </div>
      <div ref="logContainer" class="max-h-64 overflow-auto p-4 font-mono text-xs">
        <p v-if="events.length === 0" class="text-muted-foreground">Waiting for job events...</p>
        <p v-for="event in events" :key="event.sequence" class="border-b py-1.5 last:border-0">
          <span class="mr-2 text-muted-foreground">{{ event.type }}</span>{{ event.message }}
        </p>
      </div>
      <p
        v-if="job.error"
        class="border-t border-red-200 bg-red-50 p-3 text-sm text-red-900 dark:border-red-900 dark:bg-red-950/40 dark:text-red-200"
      >
        {{ job.error }}
      </p>
      <p
        v-else-if="job.status === 'succeeded'"
        class="border-t border-emerald-200 bg-emerald-50 p-3 text-sm text-emerald-900 dark:border-emerald-900 dark:bg-emerald-950/40 dark:text-emerald-200"
      >
        RemoteControl verified. Future status commands will prefer HTTP automatically.
      </p>
    </div>
  </section>
</template>

<script setup lang="ts">
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { Input } from '@/components/ui/input'
import { Switch } from '@/components/ui/switch'
import { useLogAutoScroll } from '@/composables/useLogAutoScroll'
import type {
  GravitInstallation,
  JobEvent,
  JobRecord,
  RemoteControlConfiguration,
  RemoteControlSetupInput,
} from '@gravit-panel/shared'
import { useMutation, useQuery, useQueryClient } from '@tanstack/vue-query'
import { KeyRound, LoaderCircle } from '@lucide/vue'
import { computed, onBeforeUnmount, ref, watch } from 'vue'

const props = defineProps<{ installation: GravitInstallation }>()

const queryClient = useQueryClient()
const endpoint = ref('')
const confirmed = ref(false)
const job = ref<JobRecord | null>(null)
const events = ref<JobEvent[]>([])
const { autoScroll, logContainer } = useLogAutoScroll(() => events.value.length)
let eventSource: EventSource | null = null

const getJson = async <T>(input: RequestInfo | URL, init?: RequestInit): Promise<T> => {
  const response = await fetch(input, init)
  if (!response.ok) {
    const body = (await response.json().catch(() => null)) as { message?: string } | null
    throw new Error(body?.message ?? `Request failed with status ${response.status}`)
  }
  return response.json() as Promise<T>
}

const {
  data: configuration,
  error: queryError,
} = useQuery({
  queryKey: ['remote-control-configuration'],
  queryFn: () =>
    getJson<RemoteControlConfiguration>('/api/gravit/remote-control/configuration'),
})

watch(
  () => props.installation,
  (installation) => {
    endpoint.value = `http://${installation.address}`
    confirmed.value = false
    job.value = null
    events.value = []
    eventSource?.close()
  },
  { immediate: true },
)

const configured = computed(() =>
  configuration.value?.configuredInstallationIds.includes(props.installation.id),
)

const {
  error: keyError,
  isPending: keyPending,
  mutate: generateEncryptionKey,
} = useMutation({
  mutationFn: () =>
    getJson('/api/gravit/remote-control/encryption-key', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ confirmGeneration: true }),
    }),
  onSuccess: () =>
    queryClient.invalidateQueries({ queryKey: ['remote-control-configuration'] }),
})
const terminal = computed(
  () =>
    job.value?.status === 'succeeded' ||
    job.value?.status === 'failed' ||
    job.value?.status === 'cancelled',
)

const connectToJob = (created: JobRecord) => {
  eventSource?.close()
  events.value = []
  job.value = created
  eventSource = new EventSource(`/api/jobs/${created.id}/events`)
  eventSource.addEventListener('job', (rawEvent) => {
    const event = JSON.parse((rawEvent as MessageEvent<string>).data) as JobEvent
    if (events.value.some((item) => item.sequence === event.sequence)) return
    events.value.push(event)
    if (event.progress !== null && job.value) job.value.progress = event.progress

    if (
      event.type === 'completed' ||
      event.type === 'failed' ||
      event.type === 'cancelled'
    ) {
      eventSource?.close()
      void getJson<JobRecord>(`/api/jobs/${created.id}`).then(async (record) => {
        job.value = record
        if (record.status === 'succeeded') {
          confirmed.value = false
          await queryClient.invalidateQueries({ queryKey: ['remote-control-configuration'] })
        }
      })
    }
  })
}

const {
  error: mutationError,
  isPending,
  mutate,
} = useMutation({
  mutationFn: (input: RemoteControlSetupInput) =>
    getJson<JobRecord>('/api/gravit/remote-control/setup', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(input),
    }),
  onSuccess: connectToJob,
})

const startSetup = () => {
  if (!confirmed.value) return
  mutate({
    installationId: props.installation.id,
    endpoint: endpoint.value,
    replaceExistingTokens: true,
  })
}

onBeforeUnmount(() => eventSource?.close())
</script>
