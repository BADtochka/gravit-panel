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

    <JobProgressNotifier :job="job" title="RemoteControl setup" @finished="setupFinished" />
  </section>
</template>

<script setup lang="ts">
import JobProgressNotifier from '@/components/jobs/JobProgressNotifier.vue'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { Input } from '@/components/ui/input'
import { panelFetch } from '@/lib/public-path'
import type {
  GravitInstallation,
  JobRecord,
  RemoteControlConfiguration,
  RemoteControlSetupInput,
} from '@gravit-panel/shared'
import { useMutation, useQuery, useQueryClient } from '@tanstack/vue-query'
import { KeyRound, LoaderCircle } from '@lucide/vue'
import { computed, ref, watch } from 'vue'

const props = defineProps<{ installation: GravitInstallation }>()

const queryClient = useQueryClient()
const endpoint = ref('')
const confirmed = ref(false)
const job = ref<JobRecord | null>(null)

const getJson = async <T>(input: RequestInfo | URL, init?: RequestInit): Promise<T> => {
  const response = await panelFetch(input, init)
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
  () => [props.installation, configuration.value?.defaultEndpoint] as const,
  ([installation, defaultEndpoint]) => {
    endpoint.value = defaultEndpoint ?? `http://${installation.address}`
    confirmed.value = false
    job.value = null
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

const setupFinished = async (record: JobRecord) => {
  job.value = record
  if (record.status === 'succeeded') {
    confirmed.value = false
    await queryClient.invalidateQueries({ queryKey: ['remote-control-configuration'] })
  }
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
  onSuccess: (created) => {
    job.value = created
  },
})

const startSetup = () => {
  if (!confirmed.value) return
  mutate({
    installationId: props.installation.id,
    endpoint: endpoint.value,
    replaceExistingTokens: true,
  })
}
</script>
