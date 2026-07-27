<template>
  <section class="space-y-6">
    <div class="flex flex-wrap items-start justify-between gap-4">
      <div>
        <h2 class="text-2xl font-semibold tracking-tight">Modules</h2>
        <p class="mt-1 text-sm text-muted-foreground">
          Inspect and load release-verified LaunchServer and launcher modules.
        </p>
      </div>
    </div>

    <Alert v-if="pageError" variant="destructive">
      <TriangleAlert class="size-4" />
      <AlertTitle>Module operation failed</AlertTitle>
      <AlertDescription>{{ pageError.message }}</AlertDescription>
    </Alert>

    <Card v-if="catalog">
      <CardHeader class="border-b">
        <CardTitle class="text-base">Verified artifact manifest</CardTitle>
        <CardDescription>
          Only JARs present in this pinned release and discovered in the running image can be loaded.
        </CardDescription>
      </CardHeader>
      <CardContent class="grid gap-3 pt-6 text-xs text-muted-foreground md:grid-cols-3">
        <div>
          <p class="font-medium text-foreground">LauncherModules source</p>
          <a
            class="mt-1 block font-mono underline underline-offset-4"
            :href="`${catalog.source.repository}/tree/${catalog.source.revision}`"
            target="_blank"
            rel="noreferrer"
          >
            {{ catalog.source.revision.slice(0, 12) }}
          </a>
        </div>
        <div>
          <p class="font-medium text-foreground">LaunchServer release</p>
          <a
            class="mt-1 block font-mono underline underline-offset-4"
            :href="`${catalog.release.repository}/releases/tag/${catalog.release.tag}`"
            target="_blank"
            rel="noreferrer"
          >
            {{ catalog.release.tag }} · {{ catalog.release.asset }}
          </a>
        </div>
        <div>
          <p class="font-medium text-foreground">Artifact SHA-256</p>
          <p class="mt-1 break-all font-mono">{{ catalog.release.sha256 }}</p>
        </div>
      </CardContent>
    </Card>

    <Tabs v-if="catalog" default-value="server">
      <div class="flex flex-wrap items-center justify-between gap-3">
        <TabsList>
          <TabsTrigger value="server">
            Server
            <Badge variant="secondary">{{ catalog.serverModules.length }}</Badge>
          </TabsTrigger>
          <TabsTrigger value="auth">
            Auth
            <Badge variant="secondary">{{ catalog.authModules.length }}</Badge>
          </TabsTrigger>
          <TabsTrigger value="launcher">
            Launcher
            <Badge variant="secondary">{{ catalog.launcherModules.length }}</Badge>
          </TabsTrigger>
        </TabsList>
        <Button
          variant="outline"
          size="sm"
          type="button"
          :disabled="!stateEnabled || stateFetching"
          @click="refetchState()"
        >
          <RefreshCw class="size-4" :class="{ 'animate-spin': stateFetching }" />
          Refresh state
        </Button>
      </div>

      <TabsContent
        v-for="group in moduleGroups"
        :key="group.kind"
        :value="group.kind"
        class="grid gap-4 md:grid-cols-2 xl:grid-cols-3"
      >
        <Card v-for="item in group.items" :key="item.id">
          <CardHeader>
            <div class="flex items-start justify-between gap-3">
              <div>
                <CardTitle class="text-base">{{ item.name }}</CardTitle>
                <CardDescription class="mt-1">{{ item.description }}</CardDescription>
              </div>
              <Badge :variant="badgeVariant(item.category)">
                {{ categoryLabel(item.category) }}
              </Badge>
            </div>
          </CardHeader>
          <CardContent class="space-y-4">
            <p class="break-all font-mono text-xs text-muted-foreground">{{ item.jar }}</p>
            <div class="flex flex-wrap gap-2">
              <Badge v-if="isPending(item.id)" variant="secondary">
                <LoaderCircle class="animate-spin" />
                Pending
              </Badge>
              <Badge
                v-else-if="runtimeFor(item.id)?.loaded"
                class="border-emerald-600/30 bg-emerald-600/10 text-emerald-700 dark:text-emerald-400"
                variant="outline"
              >
                <CircleCheck class="size-3" />
                Loaded
              </Badge>
              <Badge
                v-else-if="runtimeFor(item.id)?.available"
                variant="secondary"
              >
                Available
              </Badge>
              <Badge v-else-if="runtimeFor(item.id)" variant="outline">Unavailable</Badge>
              <Badge v-else variant="outline">
                {{ stateFetching ? 'Checking' : stateEnabled ? 'Not checked' : 'Locked' }}
              </Badge>
            </div>
            <div
              v-if="item.id === 'FileAuthSystem_module' && runtimeFor(item.id)?.loaded"
              class="space-y-3 rounded-md border bg-muted/30 p-3"
            >
              <div class="flex items-center justify-between gap-3">
                <div>
                  <p class="text-sm font-medium">autoSave</p>
                  <p class="text-xs text-muted-foreground">
                    Persist Database.json when LaunchServer stops.
                  </p>
                </div>
                <Switch
                  :model-value="fileAuthAutoSave"
                  :disabled="fileAuthConfigPending || configJobPending"
                  @update:model-value="fileAuthAutoSave = Boolean($event)"
                />
              </div>
              <Button
                class="w-full"
                size="sm"
                type="button"
                variant="outline"
                :disabled="fileAuthConfigPending || configJobPending"
                @click="applyFileAuthConfig"
              >
                Save module config
              </Button>
            </div>
            <p
              v-else-if="item.category === 'auth' && runtimeFor(item.id)?.loaded"
              class="text-xs text-muted-foreground"
            >
              Configure provider cores on the Auth page after this module is loaded.
            </p>
          </CardContent>
          <CardFooter v-if="!runtimeFor(item.id)?.loaded">
            <Button
              class="w-full"
              type="button"
              :disabled="!canInstall(item.id)"
              @click="installModule(item.id)"
            >
              <LoaderCircle v-if="isPending(item.id)" class="animate-spin" />
              <CircleCheck v-else-if="runtimeFor(item.id)?.loaded" />
              <Download v-else />
              {{ actionLabel(item.id) }}
            </Button>
          </CardFooter>
        </Card>
      </TabsContent>
    </Tabs>

    <JobLogCard :job="activeJob" title="Module job" @finished="jobFinished" />
  </section>
</template>

<script setup lang="ts">
import JobLogCard from '@/components/jobs/JobLogCard.vue'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from '@/components/ui/card'
import { Switch } from '@/components/ui/switch'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { useInstallationJob } from '@/composables/useInstallationJob'
import { useInstallationsStore } from '@/stores/installations'
import type {
  FileAuthModuleConfig,
  GravitModuleCatalog,
  GravitModuleCategory,
  GravitModuleState,
  JobRecord,
} from '@gravit-panel/shared'
import { useMutation, useQuery, useQueryClient } from '@tanstack/vue-query'
import {
  CircleCheck,
  Download,
  LoaderCircle,
  RefreshCw,
  TriangleAlert,
} from '@lucide/vue'
import { storeToRefs } from 'pinia'
import { computed, ref, watch } from 'vue'

const queryClient = useQueryClient()
const { selectedInstallationId } = storeToRefs(useInstallationsStore())
const fileAuthAutoSave = ref(true)
const {
  activeJob,
  activeJobError,
  attachJob,
  finishJob,
} = useInstallationJob(
  () => selectedInstallationId.value,
  ['gravit.module.install', 'gravit.module.config.apply'],
)

const getJson = async <T>(input: RequestInfo | URL, init?: RequestInit): Promise<T> => {
  const response = await fetch(input, init)
  if (!response.ok) {
    const body = (await response.json().catch(() => null)) as { message?: string } | null
    throw new Error(body?.message ?? `Request failed with status ${response.status}`)
  }
  return response.json() as Promise<T>
}

const { data: catalog, error: catalogError } = useQuery({
  queryKey: ['module-catalog'],
  queryFn: () => getJson<GravitModuleCatalog>('/api/modules/catalog'),
})
const stateEnabled = computed(() => Boolean(selectedInstallationId.value))
const {
  data: moduleState,
  error: stateError,
  isFetching: stateFetching,
  refetch: refetchState,
} = useQuery({
  queryKey: computed(() => ['module-state', selectedInstallationId.value]),
  queryFn: () =>
    getJson<GravitModuleState>(
      `/api/modules/state?installationId=${encodeURIComponent(selectedInstallationId.value)}`,
    ),
  enabled: stateEnabled,
  retry: false,
})

const fileAuthLoaded = computed(
  () => moduleState.value?.items.find((item) => item.id === 'FileAuthSystem_module')?.loaded,
)
const {
  data: fileAuthConfig,
  error: fileAuthConfigError,
  isFetching: fileAuthConfigPending,
} = useQuery({
  queryKey: computed(() => ['fileauth-module-config', selectedInstallationId.value]),
  queryFn: () =>
    getJson<FileAuthModuleConfig>(
      `/api/auth/modules/fileauthsystem?installationId=${encodeURIComponent(selectedInstallationId.value)}`,
    ),
  enabled: computed(() => stateEnabled.value && Boolean(fileAuthLoaded.value)),
  retry: false,
})
watch(
  () => fileAuthConfig.value?.autoSave,
  (value) => {
    if (typeof value === 'boolean') fileAuthAutoSave.value = value
  },
  { immediate: true },
)

const runtimeFor = (moduleId: string) =>
  moduleState.value?.items.find((item) => item.id === moduleId)

const activeJobTerminal = computed(
  () =>
    activeJob.value?.status === 'succeeded' ||
    activeJob.value?.status === 'failed' ||
    activeJob.value?.status === 'cancelled',
)
const isPending = (moduleId: string) =>
  Boolean(
    (!activeJobTerminal.value && activeJob.value?.input.moduleId === moduleId) ||
      runtimeFor(moduleId)?.pendingJobId,
  )
const canInstall = (moduleId: string) =>
  Boolean(
    stateEnabled.value &&
      runtimeFor(moduleId)?.available &&
      !runtimeFor(moduleId)?.loaded &&
      !isPending(moduleId) &&
      !installPending.value,
  )
const actionLabel = (moduleId: string) => {
  if (isPending(moduleId)) return 'Loading'
  const runtime = runtimeFor(moduleId)
  if (runtime?.loaded) return 'Loaded'
  if (runtime?.available) return 'Install and load'
  if (runtime) return 'Unavailable'
  return stateEnabled.value ? 'State not checked' : 'Locked'
}
const categoryLabel = (category: GravitModuleCategory) => {
  if (category === 'auth') return 'Auth'
  if (category === 'launcher') return 'Launcher'
  return 'Server'
}
const badgeVariant = (category: GravitModuleCategory) => {
  if (category === 'auth') return 'secondary' as const
  if (category === 'launcher') return 'outline' as const
  return 'default' as const
}

const moduleGroups = computed(() => [
  { kind: 'server', items: catalog.value?.serverModules ?? [] },
  { kind: 'auth', items: catalog.value?.authModules ?? [] },
  { kind: 'launcher', items: catalog.value?.launcherModules ?? [] },
])

const {
  error: installError,
  isPending: installPending,
  mutate,
} = useMutation({
  mutationFn: (moduleId: string) =>
    getJson<JobRecord>('/api/modules/install', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        installationId: selectedInstallationId.value,
        moduleId,
      }),
    }),
  onSuccess: attachJob,
})

const {
  error: configError,
  isPending: configPending,
  mutate: mutateConfig,
} = useMutation({
  mutationFn: () =>
    getJson<JobRecord>('/api/auth/modules/fileauthsystem', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        installationId: selectedInstallationId.value,
        autoSave: fileAuthAutoSave.value,
        confirmConfigWrite: true,
      }),
    }),
  onSuccess: attachJob,
})

const configJobPending = computed(
  () =>
    configPending.value ||
    activeJob.value?.status === 'queued' ||
    activeJob.value?.status === 'running',
)

const installModule = (moduleId: string) => mutate(moduleId)
const applyFileAuthConfig = () => mutateConfig()
const jobFinished = async (job: JobRecord) => {
  await finishJob(job)
  await queryClient.invalidateQueries({
    queryKey: ['module-state', selectedInstallationId.value],
  })
  await queryClient.invalidateQueries({
    queryKey: ['fileauth-module-config', selectedInstallationId.value],
  })
}

const pageError = computed(
  () =>
    (catalogError.value ||
      stateError.value ||
      installError.value ||
      configError.value ||
      fileAuthConfigError.value ||
      activeJobError.value) as Error | null,
)
</script>
