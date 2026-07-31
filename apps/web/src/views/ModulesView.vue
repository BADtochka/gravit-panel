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

    <Alert v-else-if="moduleState?.busy">
      <LoaderCircle class="size-4 animate-spin" />
      <AlertTitle>LaunchServer is busy</AlertTitle>
      <AlertDescription>
        Waiting for {{ moduleState.activeJob?.type ?? 'the current operation' }} to finish.
        Module state will refresh automatically.
      </AlertDescription>
    </Alert>

    <Card v-if="catalog">
      <CardHeader class="border-b">
        <CardTitle class="text-base">Verified artifact manifest</CardTitle>
        <CardDescription>
          Only JARs present in this pinned release can be loaded. Built-in local modules are verified
          after publication to the panel LaunchServer.
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
        <Card v-for="item in group.items" :key="item.id" class="h-full">
          <CardHeader>
            <div class="flex items-start justify-between gap-3">
              <div>
                <CardTitle class="text-base">{{ item.name }}</CardTitle>
                <CardDescription class="mt-1">{{ item.description }}</CardDescription>
              </div>
              <div class="flex shrink-0 gap-1">
                <Badge v-if="isCommunityModule(item)" variant="outline">Community</Badge>
                <Badge :variant="badgeVariant(item.category)">
                  {{ categoryLabel(item.category) }}
                </Badge>
              </div>
            </div>
          </CardHeader>
          <CardContent class="flex flex-1 flex-col space-y-4">
            <div class="space-y-1">
              <p class="break-all font-mono text-xs text-muted-foreground">{{ item.jar }}</p>
              <a
                class="inline-flex items-center gap-1 text-xs text-muted-foreground underline underline-offset-4 hover:text-foreground"
                :href="moduleSourceUrl(item)"
                target="_blank"
                rel="noreferrer"
              >
                <ExternalLink class="size-3" />
                Source
              </a>
            </div>
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
              <Badge v-else-if="runtimeFor(item.id)?.built" variant="secondary">Built</Badge>
              <Badge
                v-else-if="runtimeFor(item.id)?.available"
                variant="secondary"
              >
                Available
              </Badge>
              <Badge
                v-else-if="runtimeFor(item.id) && item.id !== 'DiscordAuthSystem_module'"
                variant="outline"
              >
                Unavailable
              </Badge>
              <Badge v-else-if="runtimeFor(item.id)" variant="outline">Not built</Badge>
              <Badge v-else variant="outline">
                {{ stateFetching ? 'Checking' : stateEnabled ? 'Not checked' : 'Locked' }}
              </Badge>
            </div>
            <p
              v-if="item.category === 'auth' && runtimeFor(item.id)?.loaded"
              class="text-xs text-muted-foreground"
            >
              Configure provider cores on the Auth page after this module is loaded.
            </p>
          </CardContent>
          <CardFooter v-if="runtimeFor(item.id)?.loaded" class="space-y-2">
            <AlertDialog>
              <AlertDialogTrigger as-child>
                <Button
                  class="w-full"
                  type="button"
                  variant="destructive"
                  :disabled="!canRemove(item.id)"
                >
                  <LoaderCircle v-if="isPending(item.id)" class="animate-spin" />
                  <Trash2 v-else />
                  Remove module
                </Button>
              </AlertDialogTrigger>
              <AlertDialogContent>
                <AlertDialogHeader>
                  <AlertDialogTitle>Remove {{ item.name }}?</AlertDialogTitle>
                  <AlertDialogDescription>
                    The module JAR and its startup entry will be removed, then LaunchServer will restart.
                    Module configuration files will be kept.
                  </AlertDialogDescription>
                </AlertDialogHeader>
                <AlertDialogFooter>
                  <AlertDialogCancel>Cancel</AlertDialogCancel>
                  <AlertDialogAction @click="removeModule(item.id)">Remove module</AlertDialogAction>
                </AlertDialogFooter>
              </AlertDialogContent>
            </AlertDialog>
          </CardFooter>
          <CardFooter v-else class="space-y-2">
            <Button
              v-if="item.id === 'DiscordAuthSystem_module' && !runtimeFor(item.id)?.built"
              class="w-full bg-white text-black hover:bg-white/90 dark:bg-white dark:text-black dark:hover:bg-white/90"
              type="button"
              :disabled="!stateEnabled || isBuildPending"
              @click="buildDiscordModule"
            >
              <LoaderCircle v-if="isBuildPending" class="animate-spin" />
              <Download v-else />
              Build module
            </Button>
            <Button
              v-if="item.id !== 'DiscordAuthSystem_module' || runtimeFor(item.id)?.available"
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

    <JobProgressNotifier :job="activeJob" title="Module job" @finished="jobFinished" />
  </section>
</template>

<script setup lang="ts">
import JobProgressNotifier from '@/components/jobs/JobProgressNotifier.vue'
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
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from '@/components/ui/card'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { useInstallationJob } from '@/composables/useInstallationJob'
import { useLaunchServerStore } from '@/stores/launchserver'
import type {
  GravitModuleCatalog,
  GravitModuleCatalogItem,
  GravitModuleCategory,
  GravitModuleState,
  JobRecord,
} from '@gravit-panel/shared'
import { useMutation, useQuery } from '@tanstack/vue-query'
import {
  CircleCheck,
  Download,
  ExternalLink,
  LoaderCircle,
  RefreshCw,
  Trash2,
  TriangleAlert,
} from '@lucide/vue'
import { storeToRefs } from 'pinia'
import { computed, ref, watch } from 'vue'

const { launchServerId } = storeToRefs(useLaunchServerStore())
const {
  activeJob,
  activeJobError,
  attachJob,
  finishJob,
} = useInstallationJob(
  () => launchServerId.value,
  ['gravit.module.install', 'gravit.module.remove', 'gravit.module.discordauthsystem.build'],
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
const stateEnabled = computed(() => Boolean(launchServerId.value))
const {
  data: moduleState,
  error: stateError,
  isFetching: stateFetching,
  refetch: refetchState,
} = useQuery({
  queryKey: computed(() => ['module-state', launchServerId.value]),
  queryFn: () =>
    getJson<GravitModuleState>(
      `/api/modules/state?installationId=${encodeURIComponent(launchServerId.value)}`,
    ),
  enabled: stateEnabled,
  retry: false,
  refetchInterval: (query) => query.state.data?.busy ? 2_000 : false,
})

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
      (!activeJobTerminal.value &&
        moduleId === 'DiscordAuthSystem_module' &&
        activeJob.value?.type === 'gravit.module.discordauthsystem.build') ||
      runtimeFor(moduleId)?.pendingJobId,
  )
const canInstall = (moduleId: string) =>
  Boolean(
    stateEnabled.value &&
      !moduleState.value?.busy &&
      runtimeFor(moduleId)?.available &&
      !runtimeFor(moduleId)?.loaded &&
      !isPending(moduleId) &&
      !installPending.value,
  )
const canRemove = (moduleId: string) =>
  Boolean(
    stateEnabled.value &&
      !moduleState.value?.busy &&
      runtimeFor(moduleId)?.loaded &&
      !isPending(moduleId) &&
      !removePending.value,
  )
const actionLabel = (moduleId: string) => {
  if (moduleState.value?.busy) return 'LaunchServer busy'
  if (isPending(moduleId)) return 'Loading'
  const runtime = runtimeFor(moduleId)
  if (runtime?.loaded) return 'Loaded'
  if (runtime?.available) return 'Install and load'
  if (runtime) return moduleId === 'DiscordAuthSystem_module' ? 'Build to enable' : 'Unavailable'
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
const moduleSourceUrl = (item: GravitModuleCatalogItem) =>
  item.source.path
    ? `${item.source.repository}/tree/${item.source.revision}/${item.source.path}`
    : `${item.source.repository}/tree/${item.source.revision}`
const isCommunityModule = (item: GravitModuleCatalogItem) =>
  item.source.repository !== catalog.value?.source.repository

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
        installationId: launchServerId.value,
        moduleId,
      }),
    }),
  onSuccess: attachJob,
})

const {
  error: buildError,
  isPending: buildPending,
  mutate: buildMutate,
} = useMutation({
  mutationFn: () =>
    getJson<JobRecord>('/api/modules/discordauthsystem/build', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(
        { installationId: launchServerId.value },
      ),
    }),
  onSuccess: attachJob,
})

const installModule = (moduleId: string) => mutate(moduleId)
const {
  error: removeError,
  isPending: removePending,
  mutate: removeMutate,
} = useMutation({
  mutationFn: (moduleId: string) =>
    getJson<JobRecord>('/api/modules/remove', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        installationId: launchServerId.value,
        moduleId,
        confirmRemove: true,
      }),
    }),
  onSuccess: attachJob,
})
const removeModule = (moduleId: string) => removeMutate(moduleId)
const buildDiscordModule = () => buildMutate()
const isBuildPending = computed(
  () =>
    buildPending.value ||
    activeJob.value?.status === 'queued' ||
    activeJob.value?.status === 'running',
)
const jobFinished = async (job: JobRecord) => {
  await finishJob(job)
  await refetchState()
}

const pageError = computed(
  () =>
    (catalogError.value ||
      stateError.value ||
      installError.value ||
      removeError.value ||
      buildError.value ||
      activeJobError.value) as Error | null,
)
</script>
