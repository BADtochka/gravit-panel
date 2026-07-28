<template>
  <section class="space-y-6">
    <div>
      <h2 class="text-2xl font-semibold tracking-tight">Launcher</h2>
      <p class="mt-1 text-sm text-muted-foreground">
        Inspect setup dependencies, repair them when needed, and build launcher artifacts.
      </p>
    </div>

    <Alert v-if="pageError" variant="destructive">
      <TriangleAlert class="size-4" />
      <AlertTitle>Launcher operation failed</AlertTitle>
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
      <CardFooter class="flex-wrap gap-3">
        <Button variant="outline" :disabled="!installationId || healthFetching" @click="refetchLaunchServerHealth()">
          <RefreshCw /> Check status
        </Button>
        <AlertDialog>
          <AlertDialogTrigger as-child>
            <Button variant="destructive" :disabled="operationPending">Restart LaunchServer</Button>
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
              <AlertDialogAction @click="runLaunchServerRestart">Restart LaunchServer</AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      </CardFooter>
    </Card>

    <div class="grid gap-4 lg:grid-cols-2">
      <Card>
        <CardHeader>
          <div class="flex items-start justify-between gap-3">
            <CardTitle class="text-base">MirrorHelper workspace</CardTitle>
            <Badge :variant="state?.workspaceApplied ? 'secondary' : 'destructive'">
              <CircleCheck v-if="state?.workspaceApplied" />
              {{ state?.workspaceApplied ? 'Ready' : 'Repair required' }}
            </Badge>
          </div>
          <CardDescription>
            Installed automatically during LaunchServer setup. Reapply only to repair or reset it.
          </CardDescription>
        </CardHeader>
        <CardContent class="break-all font-mono text-xs text-muted-foreground">
          sha256:{{ configuration?.sources.workspace.sha256 }}
        </CardContent>
        <CardFooter>
          <AlertDialog>
            <AlertDialogTrigger as-child>
              <Button class="w-full" variant="outline" :disabled="operationPending">
                <RefreshCw /> Reapply workspace
              </Button>
            </AlertDialogTrigger>
            <AlertDialogContent>
              <AlertDialogHeader>
                <AlertDialogTitle>Reapply MirrorHelper workspace?</AlertDialogTitle>
                <AlertDialogDescription>
                  Current workspace files will be snapshotted before replacement.
                </AlertDialogDescription>
              </AlertDialogHeader>
              <AlertDialogFooter>
                <AlertDialogCancel>Cancel</AlertDialogCancel>
                <AlertDialogAction @click="runWorkspace">Reapply workspace</AlertDialogAction>
              </AlertDialogFooter>
            </AlertDialogContent>
          </AlertDialog>
        </CardFooter>
      </Card>

      <Card>
        <CardHeader>
          <div class="flex items-start justify-between gap-3">
            <CardTitle class="text-base">LauncherPrestarter</CardTitle>
            <Badge :variant="state?.prestarterInstalled ? 'secondary' : 'destructive'">
              <CircleCheck v-if="state?.prestarterInstalled" />
              {{ state?.prestarterInstalled ? 'Ready' : 'Repair required' }}
            </Badge>
          </div>
          <CardDescription>
            Installed automatically during LaunchServer setup from a checksum-verified release.
          </CardDescription>
        </CardHeader>
        <CardContent class="space-y-1 text-xs text-muted-foreground">
          <p>{{ configuration?.sources.prestarter.tag }}</p>
          <p class="break-all font-mono">sha256:{{ configuration?.sources.prestarter.sha256 }}</p>
        </CardContent>
        <CardFooter>
          <Button class="w-full" variant="outline" :disabled="operationPending" @click="runPrestarter">
            <RefreshCw /> Reinstall Prestarter
          </Button>
        </CardFooter>
      </Card>
    </div>

    <Card>
      <CardHeader>
        <div class="flex items-start justify-between gap-3">
          <CardTitle class="text-base">Launcher build</CardTitle>
          <Badge v-if="state?.launcherBuilt" variant="secondary">
            <CircleCheck /> Completed
          </Badge>
        </div>
        <CardDescription>
          Install the compatible GUI runtime, run the allowlisted build command, and verify artifacts.
        </CardDescription>
      </CardHeader>
      <CardContent class="text-xs text-muted-foreground">
        LauncherRuntime {{ configuration?.sources.runtime.tag }} for GravitLauncher
        {{ configuration?.sources.runtime.compatibleLauncherVersion }}
      </CardContent>
      <CardFooter class="flex-wrap gap-3">
        <Button :disabled="operationPending" @click="runLauncherBuild">
          <Hammer /> {{ state?.launcherBuilt ? 'Rebuild launcher' : 'Build launcher' }}
        </Button>
        <Button variant="outline" :disabled="!installationId" @click="refetchArtifacts()">
          <RefreshCw /> Refresh artifacts
        </Button>
      </CardFooter>
    </Card>

    <Card>
      <CardHeader>
        <div class="flex items-start justify-between gap-3">
          <div>
            <CardTitle class="text-base">Launcher interface customization</CardTitle>
            <CardDescription class="mt-1">
              Replace source-defined LauncherRuntime PNG assets and rebuild both launcher artifacts.
            </CardDescription>
          </div>
          <Badge v-if="customization?.customized" variant="secondary">
            <CircleCheck /> Customized
          </Badge>
        </div>
      </CardHeader>
      <CardContent class="space-y-4">
        <Alert>
          <TriangleAlert class="size-4" />
          <AlertTitle>LauncherRuntime assets</AlertTitle>
          <AlertDescription>
            These files customize the Java launcher. The Prestarter download window has its own
            Svelte/Tauri design and requires a separate Windows source build.
          </AlertDescription>
        </Alert>
        <div class="grid gap-4 md:grid-cols-3">
          <div class="space-y-2">
            <Label for="launcher-logo">Logo (PNG)</Label>
            <Input id="launcher-logo" type="file" accept="image/png" @change="selectAsset('logo', $event)" />
            <p class="text-xs text-muted-foreground">runtime/images/logo.png · up to 2 MiB</p>
          </div>
          <div class="space-y-2">
            <Label for="launcher-background">Background (PNG)</Label>
            <Input
              id="launcher-background"
              type="file"
              accept="image/png"
              @change="selectAsset('background', $event)"
            />
            <p class="text-xs text-muted-foreground">930×560 recommended · up to 8 MiB</p>
          </div>
          <div class="space-y-2">
            <Label for="launcher-favicon">Window icon (PNG)</Label>
            <Input
              id="launcher-favicon"
              type="file"
              accept="image/png"
              @change="selectAsset('favicon', $event)"
            />
            <p class="text-xs text-muted-foreground">runtime/favicon.png · up to 2 MiB</p>
          </div>
        </div>
        <div v-if="customization?.assets.length" class="flex flex-wrap gap-2">
          <Badge v-for="asset in customization.assets" :key="asset.id" variant="outline">
            {{ asset.id }} · {{ asset.sha256.slice(0, 12) }}
          </Badge>
        </div>
      </CardContent>
      <CardFooter>
        <Button
          :disabled="operationPending || !hasSelectedCustomization"
          @click="runCustomization"
        >
          <Hammer /> Save and rebuild launcher
        </Button>
      </CardFooter>
    </Card>

    <div class="grid gap-3 md:grid-cols-2">
      <Card v-for="artifact in artifacts?.items" :key="artifact.variant">
        <CardHeader>
          <CardTitle class="text-base">{{ artifact.filename }}</CardTitle>
          <CardDescription>{{ formatBytes(artifact.size) }} · {{ artifact.variant }}</CardDescription>
        </CardHeader>
        <CardContent>
          <p class="break-all font-mono text-xs text-muted-foreground">{{ artifact.sha256 }}</p>
        </CardContent>
        <CardFooter>
          <Button as-child variant="outline" class="w-full">
            <a :href="panelUrl(artifact.downloadPath)"><Download /> Download</a>
          </Button>
        </CardFooter>
      </Card>
    </div>

    <JobLogCard :job="activeJob" title="Launcher operation" @finished="jobFinished" />
  </section>
</template>

<script setup lang="ts">
import JobLogCard from '@/components/jobs/JobLogCard.vue'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
  AlertDialogTrigger,
} from '@/components/ui/alert-dialog'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { useInstallationJob } from '@/composables/useInstallationJob'
import { panelUrl } from '@/lib/public-path'
import { useLaunchServerStore } from '@/stores/launchserver'
import type {
  ClientPreparationState, JobRecord, LauncherArtifact, LauncherCustomizationState,
  LaunchServerRuntimeHealth, SourcePin,
} from '@gravit-panel/shared'
import { useMutation, useQuery, useQueryClient } from '@tanstack/vue-query'
import {
  CircleCheck, Download, Hammer, RefreshCw, TriangleAlert,
} from '@lucide/vue'
import { storeToRefs } from 'pinia'
import { computed, ref } from 'vue'

interface Configuration {
  sources: {
    runtime: {
      tag: string
      compatibleLauncherVersion: string
    }
    workspace: { sha256: string }
    prestarter: { tag: string; sha256: string }
    launcher: SourcePin
  }
}

const queryClient = useQueryClient()
const { launchServerId: installationId } = storeToRefs(useLaunchServerStore())
const {
  activeJob,
  activeJobError,
  attachJob,
  finishJob,
} = useInstallationJob(
  () => installationId.value,
  [
    'gravit.workspace.apply',
    'gravit.prestarter.install',
    'gravit.launcher.build',
    'gravit.launcher.customize',
    'gravit.launchserver.restart',
  ],
)

const getJson = async <T>(input: RequestInfo | URL, init?: RequestInit): Promise<T> => {
  const response = await fetch(input, init)
  if (!response.ok) {
    const body = (await response.json().catch(() => null)) as { message?: string } | null
    throw new Error(body?.message ?? `Request failed with status ${response.status}`)
  }
  return response.json() as Promise<T>
}
const postJob = (url: string, body: Record<string, unknown>) =>
  getJson<JobRecord>(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })

const { data: configuration, error: configurationError } = useQuery({
  queryKey: ['client-configuration'],
  queryFn: () => getJson<Configuration>('/api/clients/configuration'),
})
const {
  data: launchServerHealth,
  error: launchServerHealthError,
  isFetching: healthFetching,
  refetch: refetchLaunchServerHealth,
} = useQuery({
  queryKey: computed(() => ['launchserver-health', installationId.value]),
  queryFn: () => getJson<LaunchServerRuntimeHealth>(
    `/api/clients/launcher/health?installationId=${encodeURIComponent(installationId.value)}`,
  ),
  enabled: computed(() => Boolean(installationId.value)),
  retry: false,
})
const { data: state, error: stateError } = useQuery({
  queryKey: computed(() => ['client-preparation-state', installationId.value]),
  queryFn: () => getJson<ClientPreparationState>(
    `/api/clients/state?installationId=${encodeURIComponent(installationId.value)}`,
  ),
  enabled: computed(() => Boolean(installationId.value)),
  retry: false,
})
const {
  data: artifacts,
  error: artifactsError,
  refetch: refetchArtifacts,
} = useQuery({
  queryKey: computed(() => ['launcher-artifacts', installationId.value]),
  queryFn: () => getJson<{ items: LauncherArtifact[] }>(
    `/api/clients/launcher/artifacts?installationId=${encodeURIComponent(installationId.value)}`,
  ),
  enabled: computed(() => Boolean(installationId.value)),
  retry: false,
})
const { data: customization, error: customizationError } = useQuery({
  queryKey: computed(() => ['launcher-customization', installationId.value]),
  queryFn: () => getJson<LauncherCustomizationState>(
    `/api/clients/launcher/customization?installationId=${encodeURIComponent(installationId.value)}`,
  ),
  enabled: computed(() => Boolean(installationId.value)),
  retry: false,
})
const {
  mutate: run,
  isPending: mutationPending,
  error: mutationError,
} = useMutation({
  mutationFn: ({ url, body }: { url: string; body: Record<string, unknown> }) =>
    postJob(url, body),
  onSuccess: attachJob,
})
const runWorkspace = () => run({
  url: '/api/clients/workspace/apply',
  body: { installationId: installationId.value, confirmDestructive: true },
})
const runPrestarter = () => run({
  url: '/api/clients/prestarter/install',
  body: { installationId: installationId.value, confirmInstallation: true },
})
const runLauncherBuild = () => run({
  url: '/api/clients/launcher/build',
  body: { installationId: installationId.value },
})
const runLaunchServerRestart = () => run({
  url: '/api/clients/launcher/restart',
  body: { installationId: installationId.value },
})
type CustomizationAssetId = 'logo' | 'background' | 'favicon'
const customizationFiles = ref<Partial<Record<CustomizationAssetId, File>>>({})
const selectAsset = (id: CustomizationAssetId, event: Event) => {
  const input = event.target as HTMLInputElement
  const file = input.files?.[0]
  if (file) customizationFiles.value = { ...customizationFiles.value, [id]: file }
  else {
    const next = { ...customizationFiles.value }
    delete next[id]
    customizationFiles.value = next
  }
}
const hasSelectedCustomization = computed(
  () => Object.keys(customizationFiles.value).length > 0,
)
const {
  mutate: customize,
  isPending: customizationPending,
  error: customizationMutationError,
} = useMutation({
  mutationFn: async () => {
    const body = new FormData()
    body.append('installationId', installationId.value)
    Object.entries(customizationFiles.value).forEach(([id, file]) => {
      body.append(id, file)
    })
    return getJson<JobRecord>('/api/clients/launcher/customization', {
      method: 'POST',
      body,
    })
  },
  onSuccess: attachJob,
})
const runCustomization = () => customize()
const operationPending = computed(
  () =>
    !installationId.value ||
    mutationPending.value ||
    customizationPending.value ||
    activeJob.value?.status === 'queued' ||
    activeJob.value?.status === 'running',
)
const pageError = computed(
  () => (
    mutationError.value ||
    customizationMutationError.value ||
    customizationError.value ||
    artifactsError.value ||
    stateError.value ||
    launchServerHealthError.value ||
    configurationError.value ||
    activeJobError.value
  ) as Error | null,
)
const jobFinished = async (job: JobRecord) => {
  await finishJob(job)
  await Promise.all([
    queryClient.invalidateQueries({
      queryKey: ['client-preparation-state', installationId.value],
    }),
    queryClient.invalidateQueries({
      queryKey: ['launcher-artifacts', installationId.value],
    }),
    queryClient.invalidateQueries({
      queryKey: ['launcher-customization', installationId.value],
    }),
    queryClient.invalidateQueries({
      queryKey: ['launchserver-health', installationId.value],
    }),
  ])
}
const formatBytes = (value: number) =>
  value >= 1024 * 1024
    ? `${(value / 1024 / 1024).toFixed(1)} MiB`
    : `${Math.ceil(value / 1024)} KiB`
</script>
