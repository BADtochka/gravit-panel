<template>
  <section class="space-y-6">
    <div class="flex flex-wrap items-start justify-between gap-3">
      <div>
        <h2 class="text-2xl font-semibold tracking-tight">Status</h2>
        <p class="mt-1 text-sm text-muted-foreground">
          Inspect LaunchServer health, run commands, and manage runtime state.
        </p>
      </div>
      <span
        class="rounded-md border px-2 py-1 text-xs"
        :class="
          health?.status === 'ok'
            ? 'text-emerald-700 dark:text-emerald-400'
            : 'text-muted-foreground'
        "
      >
        API {{ health?.status ?? 'checking' }}
      </span>
    </div>

    <Alert v-if="pageError" variant="destructive">
      <TriangleAlert class="size-4" />
      <AlertTitle>Operation failed</AlertTitle>
      <AlertDescription>{{ pageError.message }}</AlertDescription>
    </Alert>

    <Card>
      <CardHeader>
        <div class="flex items-start justify-between gap-3">
          <CardTitle class="text-base">LaunchServer</CardTitle>
          <Badge :variant="launchServerHealth?.status === 'healthy' ? 'secondary' : 'destructive'">
            <CircleCheck v-if="launchServerHealth?.status === 'healthy'" />
            {{ launchServerHealth?.status === 'healthy' ? 'Running' : 'Unavailable' }}
          </Badge>
        </div>
        <CardDescription>
          {{ launchServerHealth?.message ?? 'Check the container and LaunchServer control socket.' }}
        </CardDescription>
      </CardHeader>
      <CardContent class="text-xs text-muted-foreground">
        <template v-if="launchServerHealth">
          Last checked: {{ new Date(launchServerHealth.checkedAt).toLocaleString() }}
        </template>
      </CardContent>
      <CardFooter class="flex-wrap gap-2">
        <Button variant="outline" :disabled="!launchServerId || healthFetching" @click="refetchLaunchServerHealth()">
          <RefreshCw /> Check status
        </Button>
        <Button variant="outline" :disabled="!launchServerId || actionPending" @click="syncProfiles()">
          <RefreshCw /> Sync profiles
        </Button>
        <Button variant="outline" :disabled="!launchServerId || actionPending" @click="reloadConfig()">
          <RefreshCw /> Reload config
        </Button>
        <AlertDialog>
          <AlertDialogTrigger as-child>
            <Button variant="destructive" :disabled="actionPending">Restart</Button>
          </AlertDialogTrigger>
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>Restart LaunchServer?</AlertDialogTitle>
              <AlertDialogDescription>
                Connected users will be interrupted while LaunchServer starts and its control socket becomes ready.
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel>Cancel</AlertDialogCancel>
              <AlertDialogAction @click="restartLaunchServer">Restart</AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      </CardFooter>
    </Card>

    <div v-if="launchServer" class="grid gap-6 lg:grid-cols-[20rem_minmax(0,1fr)]">
      <aside class="space-y-4">
        <div class="rounded-lg border bg-card p-4">
          <p class="text-sm font-medium">Installation</p>
          <p class="mt-1 text-xs text-muted-foreground">{{ launchServer.projectName }}</p>
          <p class="mt-3 break-all font-mono text-xs text-muted-foreground">
            {{ launchServer.path }}
          </p>
          <p class="mt-2 text-xs text-muted-foreground">{{ launchServer.address }}</p>
          <p class="mt-1 font-mono text-xs text-muted-foreground">
            {{ launchServer.sourceRevision.slice(0, 12) }}
          </p>
        </div>

        <div class="grid gap-2">
          <Button
            type="button"
            :disabled="commandPending || !commandsEnabled"
            @click="runCommand('serverStatus')"
          >
            <Activity class="size-4" />
            Server status
          </Button>
          <Button
            variant="outline"
            type="button"
            :disabled="commandPending || !commandsEnabled"
            @click="runCommand('securitycheck')"
          >
            <ShieldCheck class="size-4" />
            Security check
          </Button>
        </div>

        <div class="rounded-lg border border-destructive/30 p-4">
          <p class="text-sm font-medium text-destructive">Danger zone</p>
          <p class="mt-1 text-xs text-muted-foreground">
            The panel manages a single LaunchServer. Delete it only to rebuild from scratch.
          </p>
          <LaunchServerRemovalButton class="mt-3" />
        </div>
      </aside>

      <div class="min-w-0 overflow-hidden rounded-lg border bg-card">
        <div class="flex min-h-12 items-center justify-between gap-3 border-b px-4 py-2">
          <div>
            <p class="text-sm font-medium">Command output</p>
            <p v-if="result" class="text-xs text-muted-foreground">
              {{ result.command }} · {{ result.transport }} · {{ formatTime(result.finishedAt) }}
            </p>
          </div>
          <LoaderCircle v-if="commandPending" class="size-4 animate-spin text-muted-foreground" />
        </div>

        <div class="min-h-80 max-h-[38rem] overflow-auto p-4 font-mono text-xs">
          <p v-if="commandPending" class="text-muted-foreground">
            Waiting for the control socket and command output...
          </p>
          <p v-else-if="commandError" class="text-destructive">{{ commandError.message }}</p>
          <p v-else-if="!result" class="text-muted-foreground">
            Run a status or security command to inspect LaunchServer.
          </p>
          <div v-else-if="result.lines.length" class="space-y-1">
            <p v-for="(line, index) in result.lines" :key="`${index}-${line}`" class="break-words">
              {{ line }}
            </p>
          </div>
          <p v-else class="text-muted-foreground">The command completed without log output.</p>
          <p
            v-if="result?.fallbackReason"
            class="mt-4 rounded-md border border-amber-200 bg-amber-50 p-3 font-sans text-sm text-amber-950 dark:border-amber-900 dark:bg-amber-950/40 dark:text-amber-100"
          >
            RemoteControl failed, so this command used control-file:
            {{ result.fallbackReason }}
          </p>
        </div>

        <div v-if="result" class="border-t px-4 py-3 text-xs text-muted-foreground">
          Verified against
          <a
            class="font-medium underline underline-offset-4"
            :href="sourceUrl"
            target="_blank"
            rel="noreferrer"
          >
            Launcher@{{ result.source.revision.slice(0, 12) }}
          </a>
        </div>
      </div>
    </div>

    <JobProgressNotifier :job="activeJob" title="LaunchServer operation" @finished="jobFinished" />
  </section>
</template>

<script setup lang="ts">
import LaunchServerRemovalButton from '@/components/layout/LaunchServerRemovalButton.vue'
import JobProgressNotifier from '@/components/jobs/JobProgressNotifier.vue'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
  AlertDialogTrigger,
} from '@/components/ui/alert-dialog'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from '@/components/ui/card'
import { useInstallationJob } from '@/composables/useInstallationJob'
import { useLaunchServerStore } from '@/stores/launchserver'
import type {
  ApiHealth,
  JobRecord,
  LaunchServerCommandResult,
  LaunchServerInspectionCommand,
  LaunchServerRuntimeHealth,
} from '@gravit-panel/shared'
import { useMutation, useQuery, useQueryClient } from '@tanstack/vue-query'
import { Activity, CircleCheck, LoaderCircle, RefreshCw, ShieldCheck, TriangleAlert } from '@lucide/vue'
import { storeToRefs } from 'pinia'
import { computed, ref, watch } from 'vue'

const queryClient = useQueryClient()
const { launchServer, launchServerId } = storeToRefs(useLaunchServerStore())
const result = ref<LaunchServerCommandResult | null>(null)

const {
  activeJob,
  activeJobError,
  attachJob,
  finishJob,
} = useInstallationJob(
  () => launchServerId.value,
  ['gravit.launchserver.restart'],
)

const getJson = async <T>(input: RequestInfo | URL, init?: RequestInit): Promise<T> => {
  const response = await fetch(input, init)
  if (!response.ok) {
    const body = (await response.json().catch(() => null)) as { message?: string } | null
    throw new Error(body?.message ?? `Request failed with status ${response.status}`)
  }
  return response.json() as Promise<T>
}
const postJson = <T>(url: string, body: Record<string, unknown>) =>
  getJson<T>(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })

const { data: health } = useQuery({
  queryKey: ['health'],
  queryFn: () => getJson<ApiHealth>('/api/health'),
})
watch(launchServerId, () => {
  result.value = null
})

const commandsEnabled = computed(() => Boolean(launchServerId.value))

const {
  data: launchServerHealth,
  error: launchServerHealthError,
  isFetching: healthFetching,
  refetch: refetchLaunchServerHealth,
} = useQuery({
  queryKey: computed(() => ['launchserver-health', launchServerId.value]),
  queryFn: () => getJson<LaunchServerRuntimeHealth>(
    `/api/clients/launcher/health?installationId=${encodeURIComponent(launchServerId.value)}`,
  ),
  enabled: computed(() => Boolean(launchServerId.value)),
  retry: false,
})

const {
  error: commandError,
  isPending: commandPending,
  mutate: runCommandMutation,
} = useMutation({
  mutationFn: (command: LaunchServerInspectionCommand) =>
    getJson<LaunchServerCommandResult>(
      command === 'serverStatus' ? '/api/gravit/status' : '/api/gravit/securitycheck',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ installationId: launchServerId.value }),
      },
    ),
  onSuccess: (value) => {
    result.value = value
  },
})

const runCommand = (command: LaunchServerInspectionCommand) => {
  result.value = null
  runCommandMutation(command)
}

const {
  isPending: actionPending,
  error: actionError,
  mutate: runAction,
} = useMutation({
  mutationFn: ({ url, body }: { url: string; body: Record<string, unknown> }) =>
    postJson<JobRecord>(url, body),
  onSuccess: attachJob,
})

const restartLaunchServer = () => runAction({
  url: '/api/clients/launcher/restart',
  body: { installationId: launchServerId.value },
})

const syncProfilesMutation = useMutation({
  mutationFn: () => postJson<{ lines: string[] }>(
    '/api/gravit/sync-profiles',
    { installationId: launchServerId.value },
  ),
  onSuccess: (value) => {
    result.value = {
      installationId: launchServerId.value,
      command: 'config profileprovider sync',
      transport: 'control-file',
      lines: value.lines,
      startedAt: new Date().toISOString(),
      finishedAt: new Date().toISOString(),
      source: { repository: '', revision: '', file: '' },
    }
  },
})

const reloadConfigMutation = useMutation({
  mutationFn: () => postJson<{ lines: string[] }>(
    '/api/gravit/reload-config',
    { installationId: launchServerId.value },
  ),
  onSuccess: (value) => {
    result.value = {
      installationId: launchServerId.value,
      command: 'config launchserver reload',
      transport: 'control-file',
      lines: value.lines,
      startedAt: new Date().toISOString(),
      finishedAt: new Date().toISOString(),
      source: { repository: '', revision: '', file: '' },
    }
  },
})

const syncProfiles = () => syncProfilesMutation.mutate()
const reloadConfig = () => reloadConfigMutation.mutate()

const jobFinished = async (job: JobRecord) => {
  await finishJob(job)
  await queryClient.invalidateQueries({
    queryKey: ['launchserver-health', launchServerId.value],
  })
}

const pageError = computed(
  () => (
    launchServerHealthError.value ||
    actionError.value ||
    syncProfilesMutation.error.value ||
    reloadConfigMutation.error.value ||
    activeJobError.value
  ) as Error | null,
)

const sourceUrl = computed(() => {
  if (!result.value) return '#'
  const { repository, revision, file } = result.value.source
  return `${repository}/blob/${revision}/${file}`
})

const formatTime = (value: string) =>
  new Intl.DateTimeFormat(undefined, {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).format(new Date(value))
</script>
