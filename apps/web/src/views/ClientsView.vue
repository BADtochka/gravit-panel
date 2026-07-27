<template>
  <section class="space-y-6">
    <div>
      <h2 class="text-2xl font-semibold tracking-tight">Clients</h2>
      <p class="mt-1 text-sm text-muted-foreground">
        Create or rebuild the Minecraft client for the selected panel profile.
      </p>
    </div>

    <Alert v-if="pageError" variant="destructive">
      <TriangleAlert class="size-4" />
      <AlertTitle>Client build failed</AlertTitle>
      <AlertDescription>{{ pageError.message }}</AlertDescription>
    </Alert>

    <Card>
      <CardHeader>
        <div class="flex items-start justify-between gap-3">
          <CardTitle class="text-base">Build Minecraft client</CardTitle>
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
          <Input id="client-name" v-model="clientName" class="mt-1" />
          <p class="mt-1 text-xs text-muted-foreground">
            Defaults to the selected panel profile name.
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

    <JobLogCard :job="activeJob" title="Client build" @finished="jobFinished" />
  </section>
</template>

<script setup lang="ts">
import MinecraftVersionCombobox from '@/components/clients/MinecraftVersionCombobox.vue'
import JobLogCard from '@/components/jobs/JobLogCard.vue'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { useInstallationJob } from '@/composables/useInstallationJob'
import { useInstallationsStore } from '@/stores/installations'
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
  CircleCheck, PackagePlus, RefreshCw, ShieldCheck, TriangleAlert,
} from '@lucide/vue'
import { storeToRefs } from 'pinia'
import { computed, ref, watch } from 'vue'

interface Configuration {
  loaders: MinecraftLoader[]
  sources: { mirrorHelper: SourcePin }
}

const queryClient = useQueryClient()
const { selectedInstallation, selectedInstallationId: installationId } = storeToRefs(
  useInstallationsStore(),
)
const {
  activeJob,
  activeJobError,
  attachJob,
  finishJob,
} = useInstallationJob(
  () => installationId.value,
  ['gravit.client.build'],
)
const clientName = ref('')
const version = ref('')
const loader = ref<MinecraftLoader>('FABRIC')
const mods = ref('')

watch(selectedInstallation, (installation) => {
  clientName.value = installation?.name ?? ''
}, { immediate: true })
watch(activeJob, (job) => {
  if (!job || job.type !== 'gravit.client.build') return
  if (typeof job.input.name === 'string') clientName.value = job.input.name
  if (typeof job.input.minecraftVersion === 'string') version.value = job.input.minecraftVersion
  if (
    typeof job.input.loader === 'string' &&
    ['VANILLA', 'FABRIC', 'FORGE', 'NEOFORGE', 'QUILT'].includes(job.input.loader)
  ) loader.value = job.input.loader as MinecraftLoader
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
const startClientBuild = () => buildClient({
  installationId: installationId.value,
  name: clientName.value,
  minecraftVersion: version.value,
  loader: loader.value,
  mods: mods.value.split(',').map((item) => item.trim()).filter(Boolean),
})
const canBuildClient = computed(
  () => Boolean(installationId.value && validClientName.value && version.value && loader.value),
)
const operationPending = computed(
  () =>
    mutationPending.value ||
    activeJob.value?.status === 'queued' ||
    activeJob.value?.status === 'running',
)
const pageError = computed(
  () => (
    mutationError.value ||
    compatibilityError.value ||
    versionsError.value ||
    configurationError.value ||
    activeJobError.value
  ) as Error | null,
)
const jobFinished = async (job: JobRecord) => {
  await finishJob(job)
  await Promise.all([
    queryClient.invalidateQueries({
      queryKey: ['client-profile-state', installationId.value, clientName.value],
    }),
    queryClient.invalidateQueries({
      queryKey: ['client-profiles', installationId.value],
    }),
  ])
}
</script>
