<template>
  <section class="space-y-6">
    <div class="flex flex-wrap items-start justify-between gap-4">
      <div>
        <h2 class="text-2xl font-semibold tracking-tight">Mods</h2>
        <p class="mt-1 text-sm text-muted-foreground">
          Manage installed mods, configure optional mods, and install new ones.
        </p>
      </div>
      <div class="flex gap-2">
        <Button variant="outline" :disabled="!stateReady" @click="refetchInstalled()">
          <RefreshCw /> Refresh
        </Button>
        <Dialog v-model:open="installDialogOpen">
          <DialogTrigger as-child>
            <Button :disabled="!targetReady">
              <Download /> Install mods
            </Button>
          </DialogTrigger>
          <DialogContent class="max-w-3xl max-h-[85vh] flex flex-col">
            <DialogHeader>
              <DialogTitle>Install mods from Modrinth</DialogTitle>
              <DialogDescription>
                Search and select mods to install. Results are filtered by Minecraft version, loader, and project type.
              </DialogDescription>
            </DialogHeader>
            <div class="flex-1 overflow-hidden flex flex-col gap-4 min-h-0">
              <div class="flex gap-2">
                <Input v-model="searchText" placeholder="Search mods..." @keyup.enter="searchMods" />
                <Button :disabled="!canSearch || searchPending" @click="searchMods">
                  <Search /> Search
                </Button>
              </div>
              <div v-if="searchResults?.items.length" class="flex-1 overflow-auto space-y-2 pr-1 min-h-0">
                <div
                  v-for="item in searchResults.items"
                  :key="item.projectId"
                  class="block cursor-pointer rounded-md border p-3 transition-colors hover:bg-accent"
                  :class="{ 'border-primary bg-primary/5': selectedSlugs.includes(item.slug) }"
                  @click="toggleSelected(item)"
                >
                  <div class="flex items-start gap-3">
                    <Checkbox
                      :model-value="selectedSlugs.includes(item.slug)"
                      class="mt-1"
                      @click.stop
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
                    @click.stop
                  >
                    <div class="grid gap-3 sm:grid-cols-2">
                      <div class="space-y-3 rounded-lg border bg-background p-3">
                        <div class="flex items-center justify-between gap-3">
                          <div>
                            <p class="font-medium">Client files</p>
                            <p class="text-[11px] text-muted-foreground">
                              Modrinth: {{ item.clientSide ?? 'unknown' }}
                            </p>
                          </div>
                          <Switch
                            :model-value="targetFor(item).clientMode !== 'none'"
                            :disabled="item.clientSide === 'unsupported'"
                            @update:model-value="setClientMode(item, $event ? 'required' : 'none')"
                          />
                        </div>
                        <div
                          v-if="targetFor(item).clientMode !== 'none'"
                          class="flex items-center justify-between gap-3"
                        >
                          <span>Optional in launcher</span>
                          <Switch
                            :model-value="targetFor(item).clientMode === 'optional'"
                            @update:model-value="setClientMode(item, $event ? 'optional' : 'required')"
                          />
                        </div>
                        <div
                          v-if="targetFor(item).clientMode === 'optional'"
                          class="flex items-center justify-between gap-3"
                        >
                          <span>Enabled by default</span>
                          <Switch v-model="targetFor(item).optionalEnabledByDefault" />
                        </div>
                      </div>
                      <div class="space-y-2 rounded-lg border bg-background p-3">
                        <div>
                          <p class="font-medium">Server files</p>
                          <p class="text-[11px] text-muted-foreground">
                            Modrinth: {{ item.serverSide ?? 'unknown' }}
                          </p>
                        </div>
                        <p v-if="!managedServers.length" class="text-muted-foreground">
                          No managed servers for this profile.
                        </p>
                        <label
                          v-for="server in managedServers"
                          :key="server.id!"
                          class="flex items-center justify-between gap-3 rounded-md border px-3 py-2"
                        >
                          <span>{{ server.name }}</span>
                          <Switch
                            :model-value="targetFor(item).serverBindingIds.includes(server.id!)"
                            :disabled="item.serverSide === 'unsupported'"
                            @update:model-value="toggleServerTarget(item, server.id!)"
                          />
                        </label>
                      </div>
                    </div>
                    <div
                      v-if="targetFor(item).clientMode === 'optional'"
                      class="grid gap-2 sm:grid-cols-2"
                    >
                      <Input v-model="targetFor(item).optionalName" placeholder="Launcher display name" />
                      <Input
                        v-model="targetFor(item).optionalDescription"
                        placeholder="Optional mod description"
                      />
                    </div>
                  </div>
                </div>
              </div>
              <p v-else-if="searchResults" class="py-8 text-center text-sm text-muted-foreground">No compatible mods found.</p>
              <p v-else class="py-8 text-center text-sm text-muted-foreground">
                Search for mods to install from Modrinth.
              </p>
            </div>
            <DialogFooter>
              <Button
                :disabled="!selectedSlugs.length || !selectedTargetsReady"
                @click="installSelected"
              >
                <Download /> Install selected ({{ selectedSlugs.length }})
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      </div>
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

    <ModpackImportCard
      :installation-id="installationId"
      :profile="profile"
      :minecraft-version="version"
      :loader="loader"
      :servers="managedServers"
      :disabled="!targetReady"
      @job="attachJob"
      @error="childError = $event"
    />

    <Card>
      <CardHeader>
        <div class="flex flex-wrap items-start justify-between gap-3">
          <div>
            <CardTitle class="text-base">Installed mods</CardTitle>
            <CardDescription>
              Manage installed mod files. Click to select for bulk actions.
            </CardDescription>
          </div>
          <div class="flex items-center gap-2">
            <Input
              v-model="installedSearch"
              placeholder="Filter mods..."
              class="w-48"
            />
            <Button
              v-if="installed?.items.length"
              size="sm"
              variant="ghost"
              @click="toggleAllInstalled"
            >
              {{ allInstalledSelected ? 'Clear' : 'Select all' }}
            </Button>
          </div>
        </div>
      </CardHeader>
      <CardContent class="space-y-2">
        <div
          v-if="selectedInstalledItems.length"
          class="sticky top-2 z-10 flex flex-wrap items-center gap-2 rounded-lg border bg-background/95 p-3 shadow-sm backdrop-blur"
        >
          <Badge variant="secondary">{{ selectedInstalledItems.length }} selected</Badge>
          <Button size="sm" variant="outline" @click="runBulk('enable')">
            <Power /> Enable
          </Button>
          <Button size="sm" variant="outline" @click="runBulk('disable')">
            <Power /> Disable
          </Button>
          <Button
            size="sm"
            variant="outline"
            :disabled="!bulkUpdateReady"
            @click="runBulk('update')"
          >
            <RefreshCw /> Update
          </Button>
          <AlertDialog>
            <AlertDialogTrigger as-child>
              <Button size="sm" variant="destructive">
                <Trash2 /> Remove
              </Button>
            </AlertDialogTrigger>
            <AlertDialogContent>
              <AlertDialogHeader>
                <AlertDialogTitle>
                  Remove {{ selectedInstalledItems.length }} selected mods?
                </AlertDialogTitle>
                <AlertDialogDescription>
                  Every selected file will be moved to recoverable .gravit-panel-trash.
                </AlertDialogDescription>
              </AlertDialogHeader>
              <div class="py-3">
                <label class="flex items-center gap-2 text-sm">
                  <Checkbox v-model="bulkRemoveFromServer" />
                  Also remove from managed servers
                </label>
              </div>
              <AlertDialogFooter>
                <AlertDialogCancel>Cancel</AlertDialogCancel>
                <AlertDialogAction @click="runBulk('remove')">
                  Move selected to trash
                </AlertDialogAction>
              </AlertDialogFooter>
            </AlertDialogContent>
          </AlertDialog>
        </div>
        <p v-if="!stateReady" class="py-8 text-center text-sm text-muted-foreground">Select a complete target profile.</p>
        <p v-else-if="installedFetching" class="py-8 text-center text-sm text-muted-foreground">Hashing mod files…</p>
        <p v-else-if="!installed?.items.length" class="py-8 text-center text-sm text-muted-foreground">No mod JARs detected.</p>
        <p v-else-if="!filteredInstalledItems.length" class="py-8 text-center text-sm text-muted-foreground">
          No mods match your filter.
        </p>
        <div v-else class="max-h-[32rem] space-y-2 overflow-auto pr-1">
          <div
            v-for="item in filteredInstalledItems"
            :key="item.filename"
            class="cursor-pointer rounded-md border p-3 transition-colors hover:bg-accent"
            :class="{ 'border-primary bg-primary/5': selectedInstalledFilenames.includes(item.filename) }"
            @click="toggleInstalledSelection(item.filename)"
          >
            <div class="flex items-start justify-between gap-2">
              <div class="flex min-w-0 items-start gap-3">
                <Checkbox
                  :model-value="selectedInstalledFilenames.includes(item.filename)"
                  class="mt-1"
                  @click.stop
                  @update:model-value="toggleInstalledSelection(item.filename)"
                />
                <div class="min-w-0">
                  <p class="truncate text-sm font-medium">{{ item.filename }}</p>
                  <p class="mt-1 text-xs text-muted-foreground">
                    {{ item.versionName ?? 'Unknown to Modrinth' }} · {{ formatBytes(item.size) }}
                  </p>
                </div>
              </div>
              <Badge :variant="item.disabled ? 'outline' : 'secondary'">
                {{ item.disabled ? 'Disabled' : 'Enabled' }}
              </Badge>
            </div>
            <div class="mt-3 inline-flex max-w-full flex-wrap gap-2">
              <Button size="sm" variant="outline" @click.stop="toggleMod(item)">
                <Power /> {{ item.disabled ? 'Enable' : 'Disable' }}
              </Button>
              <Button
                size="sm"
                variant="outline"
                :disabled="!item.projectId || !targetReady"
                @click.stop="updateMod(item)"
              >
                <RefreshCw /> Update
              </Button>
              <Button
                v-if="item.projectId"
                size="sm"
                variant="outline"
                @click.stop="openOptionalDialog(item)"
              >
                <Settings /> Make optional
              </Button>
              <AlertDialog>
                <AlertDialogTrigger as-child>
                  <Button size="sm" variant="destructive" @click.stop><Trash2 /> Remove</Button>
                </AlertDialogTrigger>
                <AlertDialogContent>
                  <AlertDialogHeader>
                    <AlertDialogTitle>Remove {{ item.filename }}?</AlertDialogTitle>
                    <AlertDialogDescription>
                      The file will be moved to recoverable .gravit-panel-trash inside the profile.
                    </AlertDialogDescription>
                  </AlertDialogHeader>
                  <div class="py-3">
                    <label class="flex items-center gap-2 text-sm">
                      <Checkbox v-model="item._removeFromServer" />
                      Also remove from managed servers
                    </label>
                  </div>
                  <AlertDialogFooter>
                    <AlertDialogCancel>Cancel</AlertDialogCancel>
                    <AlertDialogAction @click="removeMod(item)">Move to trash</AlertDialogAction>
                  </AlertDialogFooter>
                </AlertDialogContent>
              </AlertDialog>
            </div>
          </div>
        </div>
      </CardContent>
    </Card>

    <OptionalModsCard
      :installation-id="installationId"
      :profile="profile"
      :disabled="!stateReady"
      @job="attachJob"
      @error="childError = $event"
    />

    <Dialog v-model:open="optionalDialogOpen">
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Make mod optional</DialogTitle>
          <DialogDescription>
            Configure this mod as optional in the launcher. Users will be able to enable or disable it.
          </DialogDescription>
        </DialogHeader>
        <div v-if="optionalDialogMod" class="space-y-4">
          <div>
            <label class="text-xs font-medium">Display name</label>
            <Input v-model="optionalForm.name" class="mt-1" placeholder="Mod display name" />
          </div>
          <div>
            <label class="text-xs font-medium">Description</label>
            <textarea
              v-model="optionalForm.description"
              rows="2"
              class="mt-1 flex w-full rounded-md border border-input bg-transparent px-3 py-2 text-sm shadow-xs outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50"
              placeholder="Describe what this mod does"
            />
          </div>
          <div>
            <label class="text-xs font-medium">Category</label>
            <Input v-model="optionalForm.category" class="mt-1" placeholder="Mods" />
          </div>
          <label class="flex items-center gap-2 text-sm">
            <Checkbox v-model="optionalForm.enabledByDefault" />
            Enabled by default
          </label>
        </div>
        <DialogFooter>
          <Button variant="outline" @click="optionalDialogOpen = false">Cancel</Button>
          <Button :disabled="!optionalForm.name.trim()" @click="convertToOptional">
            Make optional
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>

    <JobProgressNotifier :job="activeJob" title="Mod operation" @finished="jobFinished" />
  </section>
</template>

<script setup lang="ts">
import MinecraftVersionCombobox from '@/components/clients/MinecraftVersionCombobox.vue'
import JobProgressNotifier from '@/components/jobs/JobProgressNotifier.vue'
import ModpackImportCard from '@/components/mods/ModpackImportCard.vue'
import OptionalModsCard from '@/components/mods/OptionalModsCard.vue'
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
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader,
  DialogTitle, DialogTrigger,
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Switch } from '@/components/ui/switch'
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
  Download, Lock, Power, RefreshCw, Search, Settings, Trash2, TriangleAlert, Unlock,
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
const installedSearch = ref('')
const selectedSlugs = ref<string[]>([])
const selectedInstalledFilenames = ref<string[]>([])
const childError = ref<Error | null>(null)
const installDialogOpen = ref(false)
const bulkRemoveFromServer = ref(false)
const optionalDialogOpen = ref(false)
const optionalDialogMod = ref<InstalledMod | null>(null)
const optionalForm = reactive({
  name: '',
  description: '',
  category: 'Mods',
  enabledByDefault: false,
})
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
    'gravit.mods.bulk',
    'gravit.mods.optional.update',
    'gravit.mods.optional.remove',
    'gravit.mods.modpack.import',
  ],
)
watch(installationId, () => {
  selectedSlugs.value = []
  selectedInstalledFilenames.value = []
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
  selectedInstalledFilenames.value = []
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
const filteredInstalledItems = computed(() => {
  const items = installed.value?.items ?? []
  const search = installedSearch.value.trim().toLowerCase()
  if (!search) return items
  return items.filter((item) =>
    item.filename.toLowerCase().includes(search) ||
    (item.versionName?.toLowerCase().includes(search) ?? false),
  )
})
const selectedInstalledItems = computed(
  () => installed.value?.items.filter(
    (item) => selectedInstalledFilenames.value.includes(item.filename),
  ) ?? [],
)
const allInstalledSelected = computed(
  () => Boolean(
    installed.value?.items.length &&
    selectedInstalledItems.value.length === installed.value.items.length,
  ),
)
const bulkUpdateReady = computed(
  () => Boolean(
    targetReady.value &&
    selectedInstalledItems.value.length &&
    selectedInstalledItems.value.every((item) => item.projectId),
  ),
)
watch(installed, (value) => {
  const available = new Set(value?.items.map((item) => item.filename) ?? [])
  selectedInstalledFilenames.value = selectedInstalledFilenames.value.filter(
    (filename) => available.has(filename),
  )
})

const {
  data: searchResults, error: searchError, isPending: searchPending, mutate: runSearch,
} = useMutation({
  mutationFn: () => getJson<{ items: ModrinthProject[] }>(
    `/api/mods/search?query=${encodeURIComponent(searchText.value)}&minecraftVersion=${encodeURIComponent(version.value)}&loader=${loader.value}`,
  ),
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
  optionalEnabledByDefault: false,
  optionalName: item.title,
  optionalDescription: item.description,
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
  mutate: runOperation, error: operationError,
} = useMutation({
  mutationFn: ({ url, body }: { url: string; body: Record<string, unknown> }) => postJob(url, body),
  onSuccess: attachJob,
})
const commonBody = () => ({
  installationId: installationId.value,
  profile: profile.value,
})
const installSelected = () => {
  runOperation({
    url: '/api/mods/install',
    body: {
      ...commonBody(),
      minecraftVersion: version.value,
      loader: loader.value,
      slugs: selectedSlugs.value,
      selections: selectedSlugs.value.map((slug) => selectionTargets[slug]!),
    },
  })
  installDialogOpen.value = false
}
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
const removeMod = (item: InstalledMod & { _removeFromServer?: boolean }) => runOperation({
  url: '/api/mods/remove',
  body: {
    ...commonBody(),
    filename: item.filename,
    confirmRemoval: true,
    removeFromServer: item._removeFromServer ?? false,
  },
})
const openOptionalDialog = (item: InstalledMod) => {
  optionalDialogMod.value = item
  optionalForm.name = item.name ?? item.filename.replace(/\.jar(?:\.disabled)?$/, '')
  optionalForm.description = item.description ?? ''
  optionalForm.category = 'Mods'
  optionalForm.enabledByDefault = false
  optionalDialogOpen.value = true
}
const convertToOptional = () => {
  if (!optionalDialogMod.value?.projectId) return
  runOperation({
    url: '/api/mods/optional/update',
    body: {
      ...commonBody(),
      projectId: optionalDialogMod.value.projectId,
      name: optionalForm.name.trim(),
      description: optionalForm.description.trim(),
      category: optionalForm.category.trim() || 'Mods',
      enabledByDefault: optionalForm.enabledByDefault,
    },
  })
  optionalDialogOpen.value = false
}
const toggleInstalledSelection = (filename: string) => {
  selectedInstalledFilenames.value = selectedInstalledFilenames.value.includes(filename)
    ? selectedInstalledFilenames.value.filter((item) => item !== filename)
    : [...selectedInstalledFilenames.value, filename]
}
const toggleAllInstalled = () => {
  selectedInstalledFilenames.value = allInstalledSelected.value
    ? []
    : installed.value?.items.map((item) => item.filename) ?? []
}
const runBulk = (action: 'enable' | 'disable' | 'update' | 'remove') => {
  if (!selectedInstalledFilenames.value.length) return
  runOperation({
    url: '/api/mods/bulk',
    body: {
      ...commonBody(),
      filenames: selectedInstalledFilenames.value,
      action,
      ...(action === 'update'
        ? { minecraftVersion: version.value, loader: loader.value }
        : {}),
      ...(action === 'remove'
        ? { confirmRemoval: true, removeFromServer: bulkRemoveFromServer.value }
        : {}),
    },
  })
}
const jobFinished = async (job: JobRecord) => {
  await finishJob(job)
  if (job.status === 'succeeded') {
    selectedSlugs.value = []
    selectedInstalledFilenames.value = []
  }
  await queryClient.invalidateQueries({
    queryKey: ['installed-mods', installationId.value, profile.value],
  })
  await queryClient.invalidateQueries({ queryKey: ['server-pack'] })
  await queryClient.invalidateQueries({ queryKey: ['server-bindings'] })
  await queryClient.invalidateQueries({
    queryKey: ['optional-mods', installationId.value, profile.value],
  })
}
const pageError = computed(
  () => (
    searchError.value ||
    installedError.value ||
    operationError.value ||
    versionsError.value ||
    profilesError.value ||
    activeJobError.value
    || childError.value
  ) as Error | null,
)
const formatBytes = (value: number) =>
  value >= 1024 * 1024 ? `${(value / 1024 / 1024).toFixed(1)} MiB` : `${Math.ceil(value / 1024)} KiB`
const formatDownloads = (value: number) =>
  new Intl.NumberFormat(undefined, { notation: 'compact' }).format(value)
</script>
