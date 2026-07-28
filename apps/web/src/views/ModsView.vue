<template>
  <section class="space-y-6">
    <div class="flex flex-wrap items-start justify-between gap-4">
      <div>
        <h2 class="text-2xl font-semibold tracking-tight">Mods</h2>
        <p class="mt-1 text-sm text-muted-foreground">
          Search Modrinth, install through MirrorHelper, and manage detected JARs.
        </p>
      </div>
      <Button variant="outline" :disabled="!stateReady" @click="refetchInstalled()">
        <RefreshCw /> Refresh installed
      </Button>
    </div>

    <Alert v-if="pageError" variant="destructive">
      <TriangleAlert class="size-4" />
      <AlertTitle>Mod operation failed</AlertTitle>
      <AlertDescription>{{ pageError.message }}</AlertDescription>
    </Alert>

    <Card>
      <CardHeader>
        <div class="flex flex-wrap items-start justify-between gap-3">
          <div>
            <CardTitle class="text-base">Target profile</CardTitle>
            <CardDescription class="mt-1">
              Minecraft version and loader follow the built profile unless you unlock them.
            </CardDescription>
          </div>
          <Button
            type="button"
            size="sm"
            variant="outline"
            class="cursor-pointer"
            @click="constraintsLocked = !constraintsLocked"
          >
            <Unlock v-if="constraintsLocked" />
            <Lock v-else />
            {{ constraintsLocked ? 'Unlock parameters' : 'Lock to profile' }}
          </Button>
        </div>
      </CardHeader>
      <CardContent class="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
        <div>
          <label class="text-xs font-medium" for="mods-profile">Profile</label>
          <p id="mods-profile" class="mt-1 flex h-9 items-center rounded-md border bg-muted/40 px-3 text-sm">
            {{ profile || 'No profile selected' }}
          </p>
          <p class="mt-1 text-xs text-muted-foreground">
            Switch profiles from the sidebar.
          </p>
        </div>
        <div>
          <label class="text-xs font-medium" for="mods-version">Minecraft</label>
          <MinecraftVersionCombobox
            id="mods-version"
            v-model="version"
            class="mt-1"
            :versions="versionCatalog?.items.map((item) => item.id) ?? []"
            :loading="versionsLoading"
            :disabled="constraintsLocked"
          />
        </div>
        <div>
          <label class="text-xs font-medium" for="mods-loader">Loader</label>
          <Select v-model="loader">
            <SelectTrigger id="mods-loader" class="mt-1 w-full" :disabled="constraintsLocked">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem
                v-for="item in loaders"
                :key="item"
                :value="item"
                :disabled="item === 'VANILLA'"
              >
                {{ item }}
              </SelectItem>
            </SelectContent>
          </Select>
        </div>
        <div class="flex items-center gap-2 sm:col-span-2 xl:col-span-3">
          <Badge :variant="constraintsLocked ? 'secondary' : 'outline'">
            <Lock v-if="constraintsLocked" />
            <Unlock v-else />
            {{ constraintsLocked ? 'Using profile parameters' : 'Manual override' }}
          </Badge>
          <p v-if="selectedProfile?.loader === 'VANILLA'" class="text-xs text-muted-foreground">
            Vanilla profiles do not support mod operations. Unlock and choose a mod loader to override.
          </p>
          <p
            v-else-if="selectedProfile && (!selectedProfile.minecraftVersion || !selectedProfile.loader)"
            class="text-xs text-muted-foreground"
          >
            Profile parameters could not be detected. Unlock them to continue.
          </p>
        </div>
      </CardContent>
    </Card>

    <div class="grid gap-6 xl:grid-cols-[minmax(0,1.2fr)_minmax(22rem,0.8fr)]">
      <Card>
        <CardHeader>
          <CardTitle class="text-base">Modrinth search</CardTitle>
          <CardDescription>Results are filtered by Minecraft version, loader, and project type.</CardDescription>
        </CardHeader>
        <CardContent class="space-y-4">
          <div class="flex gap-2">
            <Input v-model="searchText" placeholder="sodium" @keyup.enter="searchMods" />
            <Button :disabled="!canSearch || searchPending" @click="searchMods">
              <Search /> Search
            </Button>
          </div>
          <div v-if="searchResults?.items.length" class="max-h-[32rem] space-y-2 overflow-auto pr-1">
            <div
              v-for="item in searchResults.items"
              :key="item.projectId"
              class="block rounded-md border p-3 hover:bg-accent"
            >
              <div class="flex cursor-pointer items-start gap-3">
                <Checkbox
                  :model-value="selectedSlugs.includes(item.slug)"
                  class="mt-1"
                  @update:model-value="toggleSelected(item)"
                />
                <img v-if="item.iconUrl" :src="item.iconUrl" alt="" class="size-10 rounded-md" />
                <div class="min-w-0 flex-1">
                  <p class="font-medium">{{ item.title }}</p>
                  <p class="line-clamp-2 text-xs text-muted-foreground">{{ item.description }}</p>
                  <p class="mt-1 text-xs text-muted-foreground">
                    {{ item.author }} · {{ formatDownloads(item.downloads) }}
                  </p>
                </div>
              </div>
              <div
                v-if="selectedSlugs.includes(item.slug)"
                class="mt-3 space-y-3 border-t pt-3 text-xs"
              >
                <div class="flex flex-wrap gap-4">
                  <label class="flex items-center gap-2">
                    <Checkbox
                      :model-value="targetFor(item).clientMode === 'required'"
                      :disabled="item.clientSide === 'unsupported'"
                      @update:model-value="setClientMode(item, $event ? 'required' : 'none')"
                    />
                    Client
                  </label>
                  <label class="flex items-center gap-2">
                    <Checkbox
                      :model-value="targetFor(item).clientMode === 'optional'"
                      :disabled="item.clientSide === 'unsupported'"
                      @update:model-value="setClientMode(item, $event ? 'optional' : 'none')"
                    />
                    Optional client
                  </label>
                  <Badge variant="outline">
                    client {{ item.clientSide ?? 'unknown' }} · server
                    {{ item.serverSide ?? 'unknown' }}
                  </Badge>
                </div>
                <div>
                  <p class="mb-2 font-medium">Install on servers</p>
                  <p
                    v-if="!managedServers.length"
                    class="text-muted-foreground"
                  >
                    No managed servers for this profile.
                  </p>
                  <div class="flex flex-wrap gap-3">
                    <label
                      v-for="server in managedServers"
                      :key="server.id!"
                      class="flex items-center gap-2"
                    >
                      <Checkbox
                        :model-value="targetFor(item).serverBindingIds.includes(server.id!)"
                        :disabled="item.serverSide === 'unsupported'"
                        @update:model-value="toggleServerTarget(item, server.id!)"
                      />
                      {{ server.name }}
                    </label>
                  </div>
                </div>
              </div>
            </div>
          </div>
          <p v-else-if="searchResults" class="py-8 text-center text-sm text-muted-foreground">No compatible mods found.</p>
        </CardContent>
        <CardFooter>
          <Button
            class="w-full"
            :disabled="!selectedSlugs.length || !selectedTargetsReady || !targetReady || operationPending"
            @click="installSelected"
          >
            <Download /> Install selected ({{ selectedSlugs.length }})
          </Button>
        </CardFooter>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle class="text-base">Installed files</CardTitle>
          <CardDescription>Modrinth identity is resolved from each local file’s SHA-1 hash.</CardDescription>
        </CardHeader>
        <CardContent class="space-y-2">
          <p v-if="!stateReady" class="py-8 text-center text-sm text-muted-foreground">Select a complete target profile.</p>
          <p v-else-if="installedFetching" class="py-8 text-center text-sm text-muted-foreground">Hashing mod files…</p>
          <p v-else-if="!installed?.items.length" class="py-8 text-center text-sm text-muted-foreground">No mod JARs detected.</p>
          <div v-for="item in installed?.items" :key="item.filename" class="rounded-md border p-3">
            <div class="flex items-start justify-between gap-2">
              <div class="min-w-0">
                <p class="truncate text-sm font-medium">{{ item.filename }}</p>
                <p class="mt-1 text-xs text-muted-foreground">
                  {{ item.versionName ?? 'Unknown to Modrinth' }} · {{ formatBytes(item.size) }}
                </p>
              </div>
              <Badge :variant="item.disabled ? 'outline' : 'secondary'">
                {{ item.disabled ? 'Disabled' : 'Enabled' }}
              </Badge>
            </div>
            <div class="mt-3 flex flex-wrap gap-2">
              <Button size="sm" variant="outline" :disabled="operationPending" @click="toggleMod(item)">
                <Power /> {{ item.disabled ? 'Enable' : 'Disable' }}
              </Button>
              <Button
                size="sm"
                variant="outline"
                :disabled="operationPending || !item.projectId || !targetReady"
                @click="updateMod(item)"
              >
                <RefreshCw /> Update
              </Button>
              <AlertDialog>
                <AlertDialogTrigger as-child>
                  <Button size="sm" variant="destructive" :disabled="operationPending"><Trash2 /> Remove</Button>
                </AlertDialogTrigger>
                <AlertDialogContent>
                  <AlertDialogHeader>
                    <AlertDialogTitle>Remove {{ item.filename }}?</AlertDialogTitle>
                    <AlertDialogDescription>
                      The file will be moved to recoverable .gravit-panel-trash inside the profile.
                    </AlertDialogDescription>
                  </AlertDialogHeader>
                  <AlertDialogFooter>
                    <AlertDialogCancel>Cancel</AlertDialogCancel>
                    <AlertDialogAction @click="removeMod(item)">Move to trash</AlertDialogAction>
                  </AlertDialogFooter>
                </AlertDialogContent>
              </AlertDialog>
            </div>
          </div>
        </CardContent>
      </Card>
    </div>

    <JobLogCard :job="activeJob" title="Mod operation" @finished="jobFinished" />
  </section>
</template>

<script setup lang="ts">
import MinecraftVersionCombobox from '@/components/clients/MinecraftVersionCombobox.vue'
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
import { Checkbox } from '@/components/ui/checkbox'
import { Input } from '@/components/ui/input'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { useInstallationJob } from '@/composables/useInstallationJob'
import { useClientProfiles } from '@/composables/useClientProfiles'
import { useLaunchServerStore } from '@/stores/launchserver'
import { useProfilesStore } from '@/stores/profiles'
import type {
  ClientModMode, InstalledMod, JobRecord, MinecraftLoader,
  MinecraftVersionCatalog, ModInstallSelection, ModrinthProject,
  ProfileServerBinding,
} from '@gravit-panel/shared'
import { useMutation, useQuery, useQueryClient } from '@tanstack/vue-query'
import {
  Download, Lock, Power, RefreshCw, Search, Trash2, TriangleAlert, Unlock,
} from '@lucide/vue'
import { storeToRefs } from 'pinia'
import { computed, reactive, ref, watch } from 'vue'

const loaders = ['VANILLA', 'FABRIC', 'FORGE', 'NEOFORGE', 'QUILT'] as const
const queryClient = useQueryClient()
const { launchServerId: installationId } = storeToRefs(useLaunchServerStore())
const { selectedProfileName: profile } = storeToRefs(useProfilesStore())
const version = ref('')
const loader = ref<MinecraftLoader>('FABRIC')
const constraintsLocked = ref(true)
const searchText = ref('')
const selectedSlugs = ref<string[]>([])
const selectionTargets = reactive<Record<string, ModInstallSelection>>({})
const {
  activeJob,
  activeJobError,
  attachJob,
  finishJob,
} = useInstallationJob(
  () => installationId.value,
  [
    'gravit.mods.install',
    'gravit.mods.update',
    'gravit.mods.toggle',
    'gravit.mods.remove',
  ],
)
watch(installationId, () => {
  selectedSlugs.value = []
  version.value = ''
  loader.value = 'FABRIC'
  constraintsLocked.value = true
})

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

const {
  data: versionCatalog,
  error: versionsError,
  isPending: versionsLoading,
} = useQuery({
  queryKey: ['minecraft-versions'],
  queryFn: () => getJson<MinecraftVersionCatalog>('/api/clients/minecraft-versions'),
  staleTime: 6 * 60 * 60 * 1000,
})
const { data: profiles, error: profilesError } = useClientProfiles()
const selectedProfile = computed(
  () => profiles.value?.items.find((item) => item.name === profile.value) ?? null,
)
const applyProfileParameters = () => {
  const selected = selectedProfile.value
  if (!selected) return
  version.value = selected.minecraftVersion ?? ''
  loader.value = selected.loader ?? 'FABRIC'
}
watch(profiles, () => {
  if (constraintsLocked.value) applyProfileParameters()
}, { immediate: true })
watch(profile, () => {
  selectedSlugs.value = []
  Object.keys(selectionTargets).forEach((key) => delete selectionTargets[key])
  if (constraintsLocked.value) applyProfileParameters()
})
watch(constraintsLocked, (locked) => {
  if (locked) applyProfileParameters()
})
watch(versionCatalog, (catalog) => {
  if (!constraintsLocked.value && !version.value && catalog?.latestRelease) {
    version.value = catalog.latestRelease
  }
}, { immediate: true })

const stateReady = computed(
  () => Boolean(installationId.value && /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(profile.value)),
)
const targetReady = computed(
  () => Boolean(stateReady.value && version.value && loader.value !== 'VANILLA'),
)
const {
  data: installed, error: installedError, isFetching: installedFetching,
  refetch: refetchInstalled,
} = useQuery({
  queryKey: computed(() => ['installed-mods', installationId.value, profile.value]),
  queryFn: () => getJson<{ items: InstalledMod[] }>(
    `/api/mods/installed?installationId=${encodeURIComponent(installationId.value)}&profile=${encodeURIComponent(profile.value)}`,
  ),
  enabled: stateReady,
  retry: false,
})
const { data: serverBindings } = useQuery({
  queryKey: computed(() => ['server-bindings', installationId.value, profile.value]),
  queryFn: () => getJson<{ items: ProfileServerBinding[] }>(
    `/api/servers/profiles/${encodeURIComponent(profile.value)}/bindings` +
    `?installationId=${encodeURIComponent(installationId.value)}`,
  ),
  enabled: stateReady,
})
const managedServers = computed(
  () => serverBindings.value?.items.filter((item) => item.managed && item.id) ?? [],
)

const {
  data: searchResults, error: searchError, isPending: searchPending, mutate: runSearch,
} = useMutation({
  mutationFn: () => getJson<{ items: ModrinthProject[] }>(
    `/api/mods/search?query=${encodeURIComponent(searchText.value)}&minecraftVersion=${encodeURIComponent(version.value)}&loader=${loader.value}`,
  ),
  onSuccess: () => {
    selectedSlugs.value = []
    Object.keys(selectionTargets).forEach((key) => delete selectionTargets[key])
  },
})
const canSearch = computed(() => Boolean(searchText.value.trim() && targetReady.value))
const searchMods = () => { if (canSearch.value) runSearch() }
const defaultTargets = (item: ModrinthProject): ModInstallSelection => ({
  slug: item.slug,
  clientMode:
    item.clientSide === 'required'
      ? 'required'
      : item.clientSide === 'optional'
        ? 'optional'
        : 'none',
  serverBindingIds:
    item.serverSide === 'required'
      ? managedServers.value.flatMap((server) => server.id ? [server.id] : [])
      : [],
})
const targetFor = (item: ModrinthProject) =>
  selectionTargets[item.slug] ?? (selectionTargets[item.slug] = defaultTargets(item))
const toggleSelected = (item: ModrinthProject) => {
  if (selectedSlugs.value.includes(item.slug)) {
    selectedSlugs.value = selectedSlugs.value.filter((slug) => slug !== item.slug)
    delete selectionTargets[item.slug]
  } else {
    selectedSlugs.value = [...selectedSlugs.value, item.slug]
    selectionTargets[item.slug] = defaultTargets(item)
  }
}
const setClientMode = (item: ModrinthProject, mode: ClientModMode) => {
  targetFor(item).clientMode = mode
}
const toggleServerTarget = (item: ModrinthProject, bindingId: string) => {
  const target = targetFor(item)
  target.serverBindingIds = target.serverBindingIds.includes(bindingId)
    ? target.serverBindingIds.filter((id) => id !== bindingId)
    : [...target.serverBindingIds, bindingId]
}
const selectedTargetsReady = computed(
  () =>
    selectedSlugs.value.length > 0 &&
    selectedSlugs.value.every((slug) => {
      const target = selectionTargets[slug]
      return Boolean(
        target &&
        (target.clientMode !== 'none' || target.serverBindingIds.length > 0),
      )
    }),
)

const {
  mutate: runOperation, isPending: operationPending, error: operationError,
} = useMutation({
  mutationFn: ({ url, body }: { url: string; body: Record<string, unknown> }) => postJob(url, body),
  onSuccess: attachJob,
})
const commonBody = () => ({
  installationId: installationId.value,
  profile: profile.value,
})
const installSelected = () => runOperation({
  url: '/api/mods/install',
  body: {
    ...commonBody(),
    minecraftVersion: version.value,
    loader: loader.value,
    slugs: selectedSlugs.value,
    selections: selectedSlugs.value.map((slug) => selectionTargets[slug]!),
  },
})
const toggleMod = (item: InstalledMod) => runOperation({
  url: '/api/mods/toggle',
  body: { ...commonBody(), filename: item.filename, enabled: item.disabled },
})
const updateMod = (item: InstalledMod) => runOperation({
  url: '/api/mods/update',
  body: {
    ...commonBody(),
    filename: item.filename,
    minecraftVersion: version.value,
    loader: loader.value,
  },
})
const removeMod = (item: InstalledMod) => runOperation({
  url: '/api/mods/remove',
  body: { ...commonBody(), filename: item.filename, confirmRemoval: true },
})
const jobFinished = async (job: JobRecord) => {
  await finishJob(job)
  if (job.status === 'succeeded') selectedSlugs.value = []
  await queryClient.invalidateQueries({
    queryKey: ['installed-mods', installationId.value, profile.value],
  })
  await queryClient.invalidateQueries({ queryKey: ['server-pack'] })
  await queryClient.invalidateQueries({ queryKey: ['server-bindings'] })
}
const pageError = computed(
  () => (
    searchError.value ||
    installedError.value ||
    operationError.value ||
    versionsError.value ||
    profilesError.value ||
    activeJobError.value
  ) as Error | null,
)
const formatBytes = (value: number) =>
  value >= 1024 * 1024 ? `${(value / 1024 / 1024).toFixed(1)} MiB` : `${Math.ceil(value / 1024)} KiB`
const formatDownloads = (value: number) =>
  new Intl.NumberFormat(undefined, { notation: 'compact' }).format(value)
</script>
