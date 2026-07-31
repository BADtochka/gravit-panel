<template>
  <section class="space-y-6">
    <div class="flex flex-wrap items-start justify-between gap-3">
      <div>
        <h2 class="text-2xl font-semibold tracking-tight">Status</h2>
        <p class="mt-1 text-sm text-muted-foreground">
          Monitor LaunchServer and run audited background operations.
        </p>
      </div>
      <span
        class="rounded-md border px-2 py-1 text-xs"
        :class="health?.status === 'ok' ? 'text-emerald-700 dark:text-emerald-400' : 'text-muted-foreground'"
      >
        API {{ health?.status ?? 'checking' }}
      </span>
    </div>

    <Alert v-if="pageError" variant="destructive">
      <TriangleAlert class="size-4" />
      <AlertTitle>Operation failed</AlertTitle>
      <AlertDescription>{{ pageError.message }}</AlertDescription>
    </Alert>

    <div class="grid gap-6 lg:grid-cols-[minmax(0,1fr)_22rem]">
      <div class="space-y-6">
        <Card>
          <CardHeader>
            <div class="flex flex-wrap items-start justify-between gap-3">
              <div>
                <CardTitle class="text-base">LaunchServer health</CardTitle>
                <CardDescription class="mt-1">
                  {{ launchServerHealth?.message ?? 'Checking the container and control socket.' }}
                </CardDescription>
              </div>
              <Badge :variant="launchServerHealth?.status === 'healthy' ? 'secondary' : 'destructive'">
                <CircleCheck v-if="launchServerHealth?.status === 'healthy'" />
                {{ launchServerHealth?.status === 'healthy' ? 'Running' : 'Unavailable' }}
              </Badge>
            </div>
          </CardHeader>
          <CardContent class="grid gap-3 text-sm sm:grid-cols-2">
            <div class="rounded-lg border p-3">
              <p class="text-xs text-muted-foreground">Address</p>
              <p class="mt-1 break-all font-mono text-xs">{{ launchServer?.address ?? '—' }}</p>
            </div>
            <div class="rounded-lg border p-3">
              <p class="text-xs text-muted-foreground">Last checked</p>
              <p class="mt-1 text-xs">
                {{ launchServerHealth ? new Date(launchServerHealth.checkedAt).toLocaleString() : '—' }}
              </p>
            </div>
          </CardContent>
          <CardFooter>
            <Button
              variant="outline"
              :disabled="!launchServerId || healthFetching"
              @click="refetchLaunchServerHealth()"
            >
              <LoaderCircle v-if="healthFetching" class="animate-spin" />
              <RefreshCw v-else />
              Check health
            </Button>
          </CardFooter>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle class="text-base">Operations</CardTitle>
            <CardDescription>
              Every command runs as a persisted job. Progress and output are available from the notification or Jobs.
            </CardDescription>
          </CardHeader>
          <CardContent class="grid gap-3 sm:grid-cols-2">
            <Button
              variant="outline"
              class="h-auto items-start justify-start whitespace-normal p-4 text-left"
              :disabled="!launchServerId || operationPending"
              @click="runOperation('/api/gravit/status')"
            >
              <Activity class="mt-0.5 size-4" />
              <span>
                <span class="block font-medium">Server status</span>
                <span class="mt-1 block text-xs font-normal text-muted-foreground">
                  Inspect the current LaunchServer runtime state.
                </span>
              </span>
            </Button>
            <Button
              variant="outline"
              class="h-auto items-start justify-start whitespace-normal p-4 text-left"
              :disabled="!launchServerId || operationPending"
              @click="runOperation('/api/gravit/securitycheck')"
            >
              <ShieldCheck class="mt-0.5 size-4" />
              <span>
                <span class="block font-medium">Security check</span>
                <span class="mt-1 block text-xs font-normal text-muted-foreground">
                  Run the allowlisted LaunchServer security inspection.
                </span>
              </span>
            </Button>
            <Button
              variant="outline"
              class="h-auto items-start justify-start whitespace-normal p-4 text-left"
              :disabled="!launchServerId || operationPending"
              @click="runOperation('/api/gravit/sync-profiles')"
            >
              <RefreshCw class="mt-0.5 size-4" />
              <span>
                <span class="block font-medium">Sync profiles</span>
                <span class="mt-1 block text-xs font-normal text-muted-foreground">
                  Synchronize profiles and updates, then restart safely.
                </span>
              </span>
            </Button>
          </CardContent>
          <CardFooter class="border-t pt-6">
            <AlertDialog>
              <AlertDialogTrigger as-child>
                <Button variant="destructive" :disabled="!launchServerId || operationPending">
                  Restart LaunchServer
                </Button>
              </AlertDialogTrigger>
              <AlertDialogContent>
                <AlertDialogHeader>
                  <AlertDialogTitle>Restart LaunchServer?</AlertDialogTitle>
                  <AlertDialogDescription>
                    Connected users will be interrupted while LaunchServer and its control socket restart.
                  </AlertDialogDescription>
                </AlertDialogHeader>
                <AlertDialogFooter>
                  <AlertDialogCancel>Cancel</AlertDialogCancel>
                  <AlertDialogAction @click="runOperation('/api/clients/launcher/restart')">
                    Restart
                  </AlertDialogAction>
                </AlertDialogFooter>
              </AlertDialogContent>
            </AlertDialog>
          </CardFooter>
        </Card>
      </div>

      <aside class="space-y-6">
        <Card v-if="launchServer">
          <CardHeader>
            <CardTitle class="text-base">Installation</CardTitle>
            <CardDescription>{{ launchServer.projectName }}</CardDescription>
          </CardHeader>
          <CardContent class="space-y-3 text-xs text-muted-foreground">
            <div>
              <p>Path</p>
              <p class="mt-1 break-all font-mono text-foreground">{{ launchServer.path }}</p>
            </div>
            <div>
              <p>Source revision</p>
              <p class="mt-1 font-mono text-foreground">{{ launchServer.sourceRevision.slice(0, 12) }}</p>
            </div>
          </CardContent>
        </Card>

        <Card class="border-destructive/30">
          <CardHeader>
            <CardTitle class="text-base text-destructive">Danger zone</CardTitle>
            <CardDescription>
              Delete the managed LaunchServer only when rebuilding it from scratch.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <LaunchServerRemovalButton />
          </CardContent>
        </Card>
      </aside>
    </div>

    <JobProgressNotifier :job="activeJob" :title="activeJobTitle" @finished="jobFinished" />
  </section>
</template>

<script setup lang="ts">
import JobProgressNotifier from '@/components/jobs/JobProgressNotifier.vue'
import LaunchServerRemovalButton from '@/components/layout/LaunchServerRemovalButton.vue'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from '@/components/ui/alert-dialog'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from '@/components/ui/card'
import { useInstallationJob } from '@/composables/useInstallationJob'
import { panelFetch } from '@/lib/public-path'
import { useLaunchServerStore } from '@/stores/launchserver'
import type { ApiHealth, JobRecord, JobType, LaunchServerRuntimeHealth } from '@gravit-panel/shared'
import { useMutation, useQuery, useQueryClient } from '@tanstack/vue-query'
import {
  Activity,
  CircleCheck,
  LoaderCircle,
  RefreshCw,
  ShieldCheck,
  TriangleAlert,
} from '@lucide/vue'
import { storeToRefs } from 'pinia'
import { computed } from 'vue'

const queryClient = useQueryClient()
const { launchServer, launchServerId } = storeToRefs(useLaunchServerStore())
const supportedJobTypes = [
  'gravit.launchserver.restart',
  'gravit.launchserver.status',
  'gravit.launchserver.securitycheck',
  'gravit.launchserver.profiles.sync',
] as const
const jobTitles: Partial<Record<JobType, string>> = {
  'gravit.launchserver.restart': 'Restart LaunchServer',
  'gravit.launchserver.status': 'Inspect LaunchServer status',
  'gravit.launchserver.securitycheck': 'LaunchServer security check',
  'gravit.launchserver.profiles.sync': 'Synchronize profiles',
}

const {
  activeJob,
  activeJobError,
  attachJob,
  finishJob,
} = useInstallationJob(
  () => launchServerId.value,
  supportedJobTypes,
)

const getJson = async <T>(input: RequestInfo | URL, init?: RequestInit): Promise<T> => {
  const response = await panelFetch(input, init)
  if (!response.ok) {
    const body = (await response.json().catch(() => null)) as { message?: string } | null
    throw new Error(body?.message ?? `Request failed with status ${response.status}`)
  }
  return response.json() as Promise<T>
}

const postJob = (url: string) => getJson<JobRecord>(url, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ installationId: launchServerId.value }),
})

const { data: health } = useQuery({
  queryKey: ['health'],
  queryFn: () => getJson<ApiHealth>('/api/health'),
})

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

const operation = useMutation({
  mutationFn: postJob,
  onSuccess: attachJob,
})

const operationPending = computed(
  () => operation.isPending.value ||
    activeJob.value?.status === 'queued' ||
    activeJob.value?.status === 'running',
)
const activeJobTitle = computed(() =>
  activeJob.value ? jobTitles[activeJob.value.type] ?? 'LaunchServer operation' : 'LaunchServer operation',
)

const runOperation = (url: string) => operation.mutate(url)

const jobFinished = async (job: JobRecord) => {
  await finishJob(job)
  await Promise.all([
    queryClient.invalidateQueries({
      queryKey: ['launchserver-health', launchServerId.value],
    }),
    queryClient.invalidateQueries({ queryKey: ['jobs'] }),
  ])
}

const pageError = computed(
  () => (
    launchServerHealthError.value ||
    operation.error.value ||
    activeJobError.value
  ) as Error | null,
)
</script>
