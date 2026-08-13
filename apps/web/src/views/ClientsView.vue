<template>
  <section class="space-y-6">
    <div>
      <h2 class="text-2xl font-semibold tracking-tight">Clients</h2>
      <p class="mt-1 text-sm text-muted-foreground">
        Create, edit, rebuild, or remove the client profile selected in the sidebar.
      </p>
    </div>

    <Alert v-if="pageError" variant="destructive">
      <TriangleAlert class="size-4" />
      <AlertTitle>Profile operation failed</AlertTitle>
      <AlertDescription>{{ pageError.message }}</AlertDescription>
    </Alert>

    <Card v-if="!creatingProfile && selectedProfile">
      <CardHeader>
        <CardTitle class="text-base">Profile information</CardTitle>
        <CardDescription>
          Launcher-visible metadata. The technical profile ID remains stable so client files and
          saved launcher settings keep their association.
        </CardDescription>
      </CardHeader>
      <CardContent class="grid gap-4 md:grid-cols-2">
        <div>
          <label class="text-xs font-medium" for="profile-title">Display name</label>
          <Input id="profile-title" v-model="profileTitle" class="mt-1" maxlength="64" />
        </div>
        <div>
          <label class="text-xs font-medium" for="profile-sort-index">Sort order</label>
          <Input
            id="profile-sort-index"
            v-model.number="profileSortIndex"
            class="mt-1"
            max="10000"
            min="-10000"
            type="number"
          />
        </div>
        <div class="md:col-span-2">
          <label class="text-xs font-medium" for="profile-description">Description</label>
          <Input
            id="profile-description"
            v-model="profileDescription"
            class="mt-1"
            maxlength="512"
          />
        </div>
      </CardContent>
      <CardFooter class="flex flex-wrap justify-between gap-3">
        <Button
          :disabled="!canSaveProfile || operationPending"
          type="button"
          @click="saveProfile"
        >
          <Save class="size-4" />
          Save profile
        </Button>
        <AlertDialog>
          <AlertDialogTrigger as-child>
            <Button
              :disabled="operationPending"
              type="button"
              variant="destructive"
            >
              <Trash2 class="size-4" />
              Delete profile
            </Button>
          </AlertDialogTrigger>
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>Delete {{ selectedProfile.title }}?</AlertDialogTitle>
              <AlertDialogDescription>
                The profile JSON and its client files will disappear from LaunchServer immediately
                and be moved to recoverable panel trash.
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel>Cancel</AlertDialogCancel>
              <AlertDialogAction
                class="bg-destructive text-destructive-foreground hover:bg-destructive/90"
                @click="deleteProfile"
              >
                Delete profile
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      </CardFooter>
    </Card>

    <Card>
      <CardHeader>
        <div class="flex items-start justify-between gap-3">
          <CardTitle class="text-base">
            {{ creatingProfile ? 'Create client profile' : 'Build Minecraft client' }}
          </CardTitle>
          <Badge v-if="profileState?.built" variant="secondary">
            <CircleCheck /> Completed
          </Badge>
        </div>
        <CardDescription>
          MirrorHelper selects and merges the source-verified authlib for the requested version.
        </CardDescription>
      </CardHeader>
      <CardContent class="grid gap-4 md:grid-cols-2">
        <div>
          <label class="text-xs font-medium" for="client-name">Profile name</label>
          <Input
            id="client-name"
            v-model="clientName"
            class="mt-1"
            :disabled="!creatingProfile"
          />
          <p class="mt-1 text-xs text-muted-foreground">
            <template v-if="creatingProfile">
              New profiles appear in the sidebar switcher after the build completes.
            </template>
            <template v-else>
              Technical IDs cannot be renamed. Change the launcher-visible name above.
            </template>
          </p>
        </div>
        <div>
          <label class="text-xs font-medium" for="minecraft-version">Minecraft version</label>
          <MinecraftVersionCombobox
            id="minecraft-version"
            v-model="version"
            class="mt-1"
            :versions="versionCatalog?.items.map((item) => item.id) ?? []"
            :loading="versionsLoading"
          />
        </div>
        <div>
          <label class="text-xs font-medium" for="client-loader">Loader</label>
          <Select v-model="loader">
            <SelectTrigger id="client-loader" class="mt-1 w-full"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem v-for="item in configuration?.loaders" :key="item" :value="item">
                {{ item }}
              </SelectItem>
            </SelectContent>
          </Select>
        </div>
        <div v-if="versionedLoader">
          <label class="text-xs font-medium" for="client-loader-version">Loader version</label>
          <Select v-model="loaderVersion">
            <SelectTrigger id="client-loader-version" class="mt-1 w-full">
              <SelectValue :placeholder="loaderVersionsLoading ? 'Loading versions…' : 'Select version'" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem
                v-for="item in loaderVersionCatalog?.items ?? []"
                :key="item"
                :value="item"
              >
                {{ item }}<template v-if="item === loaderVersionCatalog?.latest"> (latest)</template>
              </SelectItem>
            </SelectContent>
          </Select>
          <p class="mt-1 text-xs text-muted-foreground">
            Modpack imports preserve their exact Forge/NeoForge version.
          </p>
        </div>
        <div>
          <label class="text-xs font-medium" for="client-mods">Modrinth slugs</label>
          <Input id="client-mods" v-model="mods" class="mt-1" placeholder="fabric-api,sodium" />
        </div>
        <Alert v-if="compatibility" class="md:col-span-2">
          <ShieldCheck class="size-4" />
          <AlertTitle>Compatibility decision</AlertTitle>
          <AlertDescription>
            {{ version }} requires {{ compatibility.authlibArtifact }}. The build stops if it is absent.
          </AlertDescription>
        </Alert>
      </CardContent>
      <CardFooter>
        <Button :disabled="!canBuildClient || operationPending" @click="startClientBuild">
          <RefreshCw v-if="profileState?.built" />
          <PackagePlus v-else />
          {{ profileState?.built ? 'Rebuild client' : 'Build client' }}
        </Button>
      </CardFooter>
    </Card>

    <JavaManagerCard
      :installation-id="installationId"
      :profile="selectedProfile"
      :disabled="operationPending"
      @job="attachJob"
      @error="childError = $event"
    />

    <JobProgressNotifier :job="activeJob" title="Profile operation" @finished="jobFinished" />
  </section>
</template>

<script setup lang="ts">
import MinecraftVersionCombobox from '@/components/clients/MinecraftVersionCombobox.vue'
import JavaManagerCard from '@/components/clients/JavaManagerCard.vue'
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
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { useClientProfiles } from '@/composables/useClientProfiles'
import { useInstallationJob } from '@/composables/useInstallationJob'
import { useLaunchServerStore } from '@/stores/launchserver'
import { useProfilesStore } from '@/stores/profiles'
import type {
  ClientCompatibility,
  ClientProfileState,
  JobRecord,
  MinecraftLoader,
  MinecraftVersionCatalog,
  SourcePin,
} from '@gravit-panel/shared'
import { useMutation, useQuery, useQueryClient } from '@tanstack/vue-query'
import {
  CircleCheck, PackagePlus, RefreshCw, Save, ShieldCheck, Trash2, TriangleAlert,
} from '@lucide/vue'
import { storeToRefs } from 'pinia'
import { computed, ref, watch } from 'vue'

interface Configuration {
  loaders: MinecraftLoader[]
  sources: { mirrorHelper: SourcePin }
}
interface LoaderVersionCatalog {
  minecraftVersion: string
  loader: 'FORGE' | 'NEOFORGE'
  latest: string | null
  items: string[]
}

const queryClient = useQueryClient()
const { launchServerId: installationId } = storeToRefs(useLaunchServerStore())
const profilesStore = useProfilesStore()
const { selectedProfileName, createRequestedAt } = storeToRefs(profilesStore)
const { data: profiles } = useClientProfiles()
const {
  activeJob,
  activeJobError,
  attachJob,
  finishJob,
} = useInstallationJob(
  () => installationId.value,
  [
    'gravit.client.build',
    'gravit.profile.update',
    'gravit.profile.java.update',
    'gravit.profile.remove',
    'gravit.java.install',
    'gravit.java.temurin.install',
    'gravit.java.remove',
    'gravit.java.settings',
  ],
)
const clientName = ref('')
const version = ref('')
const loader = ref<MinecraftLoader>('FABRIC')
const loaderVersion = ref('')
const mods = ref('')
const profileTitle = ref('')
const profileDescription = ref('')
const profileSortIndex = ref(0)
const childError = ref<Error | null>(null)
const creatingProfile = computed(() => Boolean(createRequestedAt.value))
watch(activeJob, (job) => {
  if (!job || job.type !== 'gravit.client.build') return
  if (typeof job.input.name === 'string') clientName.value = job.input.name
  if (typeof job.input.minecraftVersion === 'string') version.value = job.input.minecraftVersion
  if (
    typeof job.input.loader === 'string' &&
    ['VANILLA', 'FABRIC', 'FORGE', 'NEOFORGE', 'QUILT'].includes(job.input.loader)
  ) loader.value = job.input.loader as MinecraftLoader
  if (typeof job.input.loaderVersion === 'string') {
    loaderVersion.value = job.input.loaderVersion
  }
  if (Array.isArray(job.input.mods)) {
    mods.value = job.input.mods.filter((item): item is string => typeof item === 'string').join(',')
  }
})

const getJson = async <T>(input: RequestInfo | URL, init?: RequestInit): Promise<T> => {
  const response = await fetch(input, init)
  if (!response.ok) {
    const body = (await response.json().catch(() => null)) as { message?: string } | null
    throw new Error(body?.message ?? `Request failed with status ${response.status}`)
  }
  return response.json() as Promise<T>
}

const { data: configuration, error: configurationError } = useQuery({
  queryKey: ['client-configuration'],
  queryFn: () => getJson<Configuration>('/api/clients/configuration'),
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
watch(versionCatalog, (catalog) => {
  if (!version.value && catalog?.latestRelease) version.value = catalog.latestRelease
}, { immediate: true })
const selectedProfile = computed(
  () => profiles.value?.items.find((item) => item.name === selectedProfileName.value) ?? null,
)
const versionedLoader = computed(
  () => loader.value === 'FORGE' || loader.value === 'NEOFORGE',
)
const {
  data: loaderVersionCatalog,
  error: loaderVersionsError,
  isPending: loaderVersionsLoading,
} = useQuery({
  queryKey: computed(() => ['loader-versions', version.value, loader.value]),
  queryFn: () => getJson<LoaderVersionCatalog>(
    `/api/clients/loader-versions?minecraftVersion=${encodeURIComponent(version.value)}` +
    `&loader=${loader.value}`,
  ),
  enabled: computed(
    () => versionedLoader.value && /^[0-9]+(?:\.[0-9]+){1,3}$/.test(version.value),
  ),
  staleTime: 30 * 60 * 1000,
})
watch(
  selectedProfile,
  (profile) => {
    profileTitle.value = profile?.title ?? ''
    profileDescription.value = profile?.description ?? ''
    profileSortIndex.value = profile?.sortIndex ?? 0
  },
  { immediate: true },
)
let appliedDraftKey = ''
watch(
  [selectedProfileName, selectedProfile, createRequestedAt],
  ([name, selected, createToken]) => {
    const draftKey = createToken
      ? `new:${createToken}`
      : `profile:${name}:${selected?.minecraftVersion ?? ''}:${selected?.loader ?? ''}:${selected?.loaderVersion ?? ''}`
    if (draftKey === appliedDraftKey) return
    appliedDraftKey = draftKey

    if (createToken) {
      clientName.value = ''
      version.value = versionCatalog.value?.latestRelease ?? ''
      loader.value = 'FABRIC'
      loaderVersion.value = ''
      mods.value = ''
      return
    }

    clientName.value = name
    version.value = selected?.minecraftVersion ?? versionCatalog.value?.latestRelease ?? ''
    loader.value = selected?.loader ?? 'FABRIC'
    loaderVersion.value = selected?.loaderVersion ?? ''
    mods.value = ''
  },
  { immediate: true },
)
watch(
  [loaderVersionCatalog, versionedLoader],
  ([catalog, exact]) => {
    if (!exact) {
      loaderVersion.value = ''
      return
    }
    if (
      catalog &&
      (!loaderVersion.value || !catalog.items.includes(loaderVersion.value))
    ) {
      loaderVersion.value = catalog.latest ?? ''
    }
  },
  { immediate: true },
)

const { data: compatibility, error: compatibilityError } = useQuery({
  queryKey: computed(() => ['client-compatibility', version.value]),
  queryFn: () => getJson<ClientCompatibility>(
    `/api/clients/compatibility?minecraftVersion=${encodeURIComponent(version.value)}`,
  ),
  enabled: computed(() => /^[0-9]+(?:\.[0-9]+){1,3}$/.test(version.value)),
  retry: false,
})
const validClientName = computed(() =>
  /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/.test(clientName.value),
)
const { data: profileState } = useQuery({
  queryKey: computed(() => ['client-profile-state', installationId.value, clientName.value]),
  queryFn: () => getJson<ClientProfileState>(
    `/api/clients/profile-state?installationId=${encodeURIComponent(installationId.value)}&name=${encodeURIComponent(clientName.value)}`,
  ),
  enabled: computed(() => Boolean(installationId.value && validClientName.value)),
  retry: false,
})

const {
  mutate: buildClient,
  isPending: mutationPending,
  error: mutationError,
} = useMutation({
  mutationFn: (body: Record<string, unknown>) =>
    getJson<JobRecord>('/api/clients/build', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }),
  onSuccess: attachJob,
})
const {
  mutate: updateProfile,
  isPending: updatePending,
  error: updateError,
} = useMutation({
  mutationFn: (body: Record<string, unknown>) =>
    getJson<JobRecord>(
      `/api/clients/profiles/${encodeURIComponent(selectedProfileName.value)}/update`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      },
    ),
  onSuccess: attachJob,
})
const {
  mutate: removeProfile,
  isPending: removePending,
  error: removeError,
} = useMutation({
  mutationFn: (body: Record<string, unknown>) =>
    getJson<JobRecord>(
      `/api/clients/profiles/${encodeURIComponent(selectedProfileName.value)}/remove`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      },
    ),
  onSuccess: attachJob,
})
const startClientBuild = () => buildClient({
  installationId: installationId.value,
  name: clientName.value,
  minecraftVersion: version.value,
  loader: loader.value,
  loaderVersion: versionedLoader.value ? loaderVersion.value : null,
  mods: mods.value.split(',').map((item) => item.trim()).filter(Boolean),
})
const saveProfile = () => updateProfile({
  installationId: installationId.value,
  title: profileTitle.value.trim(),
  description: profileDescription.value.trim(),
  sortIndex: profileSortIndex.value,
})
const deleteProfile = () => removeProfile({
  installationId: installationId.value,
  confirmRemove: true,
})
const canBuildClient = computed(
  () => Boolean(
    installationId.value &&
    validClientName.value &&
    version.value &&
    loader.value &&
    (!versionedLoader.value || loaderVersion.value),
  ),
)
const canSaveProfile = computed(
  () =>
    Boolean(
      installationId.value &&
      selectedProfile.value &&
      profileTitle.value.trim() &&
      profileTitle.value.trim().length <= 64 &&
      profileDescription.value.trim() &&
      profileDescription.value.trim().length <= 512 &&
      Number.isSafeInteger(profileSortIndex.value) &&
      Math.abs(profileSortIndex.value) <= 10_000,
    ),
)
const operationPending = computed(
  () =>
    mutationPending.value ||
    updatePending.value ||
    removePending.value ||
    activeJob.value?.status === 'queued' ||
    activeJob.value?.status === 'running',
)
const pageError = computed(
  () => (
    mutationError.value ||
    updateError.value ||
    removeError.value ||
    compatibilityError.value ||
    loaderVersionsError.value ||
    versionsError.value ||
    configurationError.value ||
    childError.value ||
    activeJobError.value
  ) as Error | null,
)
const jobFinished = async (job: JobRecord) => {
  await finishJob(job)
  const affectedName =
    typeof job.input.name === 'string'
      ? job.input.name
      : typeof job.input.profileName === 'string'
        ? job.input.profileName
        : clientName.value
  await Promise.all([
    queryClient.invalidateQueries({
      queryKey: ['client-profile-state', installationId.value, affectedName],
    }),
    queryClient.invalidateQueries({
      queryKey: ['client-profiles', installationId.value],
    }),
    queryClient.invalidateQueries({
      queryKey: ['installed-mods', installationId.value, affectedName],
    }),
    queryClient.invalidateQueries({
      queryKey: ['client-java', installationId.value],
    }),
  ])
  if (
    job.status === 'succeeded' &&
    job.type === 'gravit.client.build' &&
    typeof job.input.name === 'string'
  ) {
    selectedProfileName.value = job.input.name
    profilesStore.consumeCreateRequest()
  }
}
</script>
