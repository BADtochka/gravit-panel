<template>
  <Card>
    <CardHeader>
      <CardTitle class="text-base">Import a modpack</CardTitle>
      <CardDescription>
        Upload a local .mrpack or select one from Modrinth. Files and side-specific overrides are
        validated before import.
      </CardDescription>
    </CardHeader>
    <CardContent class="space-y-4">
      <div class="space-y-3 rounded-lg border bg-muted/20 p-4">
        <div>
          <p class="text-sm font-medium">Local .mrpack</p>
          <p class="text-xs text-muted-foreground">
            Choose a pack exported by Modrinth App or another compatible tool, up to 100 MiB.
          </p>
        </div>
        <div class="flex flex-col gap-2 sm:flex-row">
          <Input
            type="file"
            accept=".mrpack,application/x-modrinth-modpack+zip,application/zip"
            :disabled="!ready || inspecting"
            @change="selectLocalFile"
          />
          <Button
            variant="outline"
            :disabled="!ready || !localFile || inspecting"
            @click="inspectLocal"
          >
            <Upload /> Inspect local pack
          </Button>
        </div>
        <p v-if="localFile" class="text-xs text-muted-foreground">
          {{ localFile.name }} · {{ formatBytes(localFile.size) }}
        </p>
      </div>

      <div class="flex items-center gap-3 text-xs text-muted-foreground">
        <span class="h-px flex-1 bg-border" />
        or import from Modrinth
        <span class="h-px flex-1 bg-border" />
      </div>

      <div class="flex gap-2">
        <Input v-model="query" placeholder="Search modpacks…" @keyup.enter="search" />
        <Button variant="outline" :disabled="!ready || !query.trim() || searching" @click="search">
          <Search /> Search packs
        </Button>
      </div>

      <div v-if="results.length" class="grid gap-2 md:grid-cols-2">
        <button
          v-for="pack in results"
          :key="pack.projectId"
          type="button"
          class="flex items-start gap-3 rounded-lg border p-3 text-left transition-colors hover:bg-accent"
          :class="{ 'border-primary bg-primary/5': selected?.projectId === pack.projectId }"
          @click="inspect(pack)"
        >
          <img v-if="pack.iconUrl" :src="pack.iconUrl" alt="" class="size-12 rounded-lg" />
          <div class="min-w-0">
            <p class="font-medium">{{ pack.title }}</p>
            <p class="line-clamp-2 text-xs text-muted-foreground">{{ pack.description }}</p>
          </div>
        </button>
      </div>

      <div v-if="inspection" class="space-y-4 rounded-lg border p-4">
        <div class="flex flex-wrap items-start justify-between gap-3">
          <div>
            <p class="font-semibold">{{ inspection.name }}</p>
            <p class="text-xs text-muted-foreground">
              {{ inspection.versionName }} · {{ inspection.files.length }} files ·
              {{ inspection.clientOverrideCount }} client overrides ·
              {{ inspection.serverOverrideCount }} server overrides
            </p>
          </div>
          <div class="flex flex-wrap gap-2">
            <Badge v-if="source === 'local'" variant="outline">Local file</Badge>
            <Badge variant="secondary">{{ inspection.minecraftVersion }} / {{ inspection.loader }}</Badge>
          </div>
        </div>

        <div class="max-h-[28rem] space-y-2 overflow-auto pr-1">
          <div
            v-for="file in inspection.files"
            :key="file.path"
            class="rounded-md border bg-muted/20 p-3"
          >
            <div class="flex items-start justify-between gap-2">
              <div class="min-w-0">
                <p class="truncate text-sm font-medium">{{ draftFor(file).name }}</p>
                <p class="truncate text-xs text-muted-foreground">{{ file.path }}</p>
              </div>
              <Badge variant="outline">{{ formatBytes(file.size) }}</Badge>
            </div>
            <div class="mt-3 grid gap-3 sm:grid-cols-2">
              <div class="space-y-2 rounded-md border bg-background p-3">
                <div class="flex items-center justify-between gap-3">
                  <div>
                    <p class="text-xs font-medium">Client</p>
                    <p class="text-[11px] text-muted-foreground">{{ file.client }}</p>
                  </div>
                  <Switch
                    :model-value="draftFor(file).clientMode !== 'none'"
                    :disabled="file.client === 'unsupported'"
                    @update:model-value="setPackClient(file, $event ? 'required' : 'none')"
                  />
                </div>
                <div
                  v-if="draftFor(file).clientMode !== 'none'"
                  class="flex items-center justify-between gap-3"
                >
                  <span class="text-xs">Optional</span>
                  <Switch
                    :model-value="draftFor(file).clientMode === 'optional'"
                    @update:model-value="setPackClient(file, $event ? 'optional' : 'required')"
                  />
                </div>
                <div
                  v-if="draftFor(file).clientMode === 'optional'"
                  class="flex items-center justify-between gap-3"
                >
                  <span class="text-xs">Enabled by default</span>
                  <Switch v-model="draftFor(file).enabledByDefault" />
                </div>
              </div>
              <div class="space-y-2 rounded-md border bg-background p-3">
                <div class="flex items-center justify-between gap-3">
                  <div>
                    <p class="text-xs font-medium">Managed servers</p>
                    <p class="text-[11px] text-muted-foreground">{{ file.server }}</p>
                  </div>
                  <Switch
                    v-model="draftFor(file).installOnServer"
                    :disabled="file.server === 'unsupported' || !servers.length"
                  />
                </div>
                <p v-if="draftFor(file).installOnServer" class="text-[11px] text-muted-foreground">
                  Installs on {{ selectedServerIds.length }} selected server(s).
                </p>
              </div>
            </div>
            <div v-if="draftFor(file).clientMode === 'optional'" class="mt-3 grid gap-2 sm:grid-cols-2">
              <Input v-model="draftFor(file).name" placeholder="Launcher display name" />
              <Input v-model="draftFor(file).description" placeholder="Description" />
            </div>
          </div>
        </div>

        <div v-if="servers.length" class="space-y-2">
          <p class="text-xs font-medium">Servers receiving selected server files and overrides</p>
          <div class="flex flex-wrap gap-2">
            <label
              v-for="server in servers"
              :key="server.id!"
              class="flex items-center gap-2 rounded-md border px-3 py-2 text-xs"
            >
              <Checkbox
                :model-value="selectedServerIds.includes(server.id!)"
                @update:model-value="toggleServer(server.id!)"
              />
              {{ server.name }}
            </label>
          </div>
        </div>
      </div>
    </CardContent>
    <CardFooter v-if="inspection">
      <Button
        class="w-full"
        :disabled="disabled || inspecting || importing || !validDrafts"
        @click="importPack"
      >
        <PackageOpen /> Import {{ inspection.name }}
      </Button>
    </CardFooter>
  </Card>
</template>

<script setup lang="ts">
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from '@/components/ui/card'
import { Checkbox } from '@/components/ui/checkbox'
import { Input } from '@/components/ui/input'
import { Switch } from '@/components/ui/switch'
import type {
  ClientModMode,
  JobRecord,
  MinecraftLoader,
  ModrinthModpackFile,
  ModrinthModpackFileSelection,
  ModrinthModpackInspection,
  ModrinthProject,
  ProfileServerBinding,
} from '@gravit-panel/shared'
import { PackageOpen, Search, Upload } from '@lucide/vue'
import { computed, reactive, ref, watch } from 'vue'

const props = defineProps<{
  installationId: string
  profile: string
  minecraftVersion: string
  loader: MinecraftLoader
  servers: ProfileServerBinding[]
  disabled: boolean
}>()
const emit = defineEmits<{
  job: [job: JobRecord]
  error: [error: Error]
}>()
const query = ref('')
const searching = ref(false)
const inspecting = ref(false)
const importing = ref(false)
const results = ref<ModrinthProject[]>([])
const selected = ref<ModrinthProject | null>(null)
const localFile = ref<File | null>(null)
const source = ref<'modrinth' | 'local'>('modrinth')
const inspection = ref<ModrinthModpackInspection | null>(null)
const drafts = reactive<Record<string, ModrinthModpackFileSelection>>({})
const selectedServerIds = ref<string[]>([])
const ready = computed(
  () => Boolean(
    props.installationId &&
    props.profile &&
    props.minecraftVersion &&
    props.loader !== 'VANILLA',
  ),
)

const request = async <T>(url: string, init?: RequestInit) => {
  const response = await fetch(url, init)
  const body = await response.json().catch(() => null) as T & { message?: string }
  if (!response.ok) throw new Error(body?.message ?? `Request failed with ${response.status}`)
  return body
}
const search = async () => {
  if (!ready.value || !query.value.trim()) return
  searching.value = true
  try {
    results.value = (await request<{ items: ModrinthProject[] }>(
      `/api/mods/modpacks/search?query=${encodeURIComponent(query.value)}` +
      `&minecraftVersion=${encodeURIComponent(props.minecraftVersion)}&loader=${props.loader}`,
    )).items
  } catch (error) {
    emit('error', error instanceof Error ? error : new Error(String(error)))
  } finally {
    searching.value = false
  }
}
const inspect = async (pack: ModrinthProject) => {
  inspecting.value = true
  try {
    const value = await request<ModrinthModpackInspection>(
      `/api/mods/modpacks/inspect?projectId=${encodeURIComponent(pack.projectId)}` +
      `&minecraftVersion=${encodeURIComponent(props.minecraftVersion)}&loader=${props.loader}`,
    )
    selected.value = pack
    source.value = 'modrinth'
    applyInspection(value)
  } catch (error) {
    emit('error', error instanceof Error ? error : new Error(String(error)))
  } finally {
    inspecting.value = false
  }
}
const selectLocalFile = (event: Event) => {
  const file = (event.target as HTMLInputElement).files?.[0] ?? null
  localFile.value = file
  if (!file) return
  if (!file.name.toLowerCase().endsWith('.mrpack')) {
    localFile.value = null
    emit('error', new Error('Choose a .mrpack file.'))
  } else if (file.size > 100 * 1024 * 1024) {
    localFile.value = null
    emit('error', new Error('Local .mrpack must not exceed 100 MiB.'))
  } else {
    selected.value = null
    source.value = 'local'
    resetInspection()
  }
}
const inspectLocal = async () => {
  if (!localFile.value || props.loader === 'VANILLA') return
  inspecting.value = true
  try {
    const body = new FormData()
    body.set('minecraftVersion', props.minecraftVersion)
    body.set('loader', props.loader)
    body.set('file', localFile.value)
    const value = await request<ModrinthModpackInspection>(
      '/api/mods/modpacks/local/inspect',
      { method: 'POST', body },
    )
    source.value = 'local'
    selected.value = null
    applyInspection(value)
  } catch (error) {
    emit('error', error instanceof Error ? error : new Error(String(error)))
  } finally {
    inspecting.value = false
  }
}
const applyInspection = (value: ModrinthModpackInspection) => {
  inspection.value = value
  Object.keys(drafts).forEach((key) => delete drafts[key])
  for (const file of value.files) drafts[file.path] = defaultDraft(file)
  selectedServerIds.value = value.files.some((file) => file.server !== 'unsupported')
    ? props.servers.flatMap((server) => server.id ? [server.id] : [])
    : []
}
const resetInspection = () => {
  inspection.value = null
  selectedServerIds.value = []
  Object.keys(drafts).forEach((key) => delete drafts[key])
}
const defaultDraft = (file: ModrinthModpackFile): ModrinthModpackFileSelection => ({
  path: file.path,
  clientMode: file.client === 'required'
    ? 'required'
    : file.client === 'optional'
      ? 'optional'
      : 'none',
  enabledByDefault: false,
  installOnServer: file.server === 'required' && props.servers.length > 0,
  name: file.name,
  description: file.description,
})
const draftFor = (file: ModrinthModpackFile) =>
  drafts[file.path] ?? (drafts[file.path] = defaultDraft(file))
const setPackClient = (file: ModrinthModpackFile, mode: ClientModMode) => {
  draftFor(file).clientMode = mode
}
const toggleServer = (id: string) => {
  selectedServerIds.value = selectedServerIds.value.includes(id)
    ? selectedServerIds.value.filter((item) => item !== id)
    : [...selectedServerIds.value, id]
}
const validDrafts = computed(
  () => Boolean(
    inspection.value &&
    inspection.value.files.every((file) => {
      const draft = drafts[file.path]
      return draft &&
        (draft.clientMode !== 'optional' || Boolean(draft.name.trim())) &&
        (!draft.installOnServer || selectedServerIds.value.length > 0)
    }),
  ),
)
const importPack = async () => {
  if (!inspection.value || props.loader === 'VANILLA') return
  importing.value = true
  try {
    const input = {
      installationId: props.installationId,
      profile: props.profile,
      projectId: inspection.value.projectId,
      minecraftVersion: props.minecraftVersion,
      loader: props.loader,
      serverBindingIds: selectedServerIds.value,
      files: inspection.value.files.map((file) => drafts[file.path]),
    }
    let job: JobRecord
    if (source.value === 'local') {
      if (!localFile.value) throw new Error('Select and inspect the local .mrpack again.')
      const body = new FormData()
      body.set('input', JSON.stringify(input))
      body.set('file', localFile.value)
      job = await request<JobRecord>('/api/mods/modpacks/local/import', {
        method: 'POST',
        body,
      })
    } else {
      job = await request<JobRecord>('/api/mods/modpacks/import', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(input),
      })
    }
    emit('job', job)
  } catch (error) {
    emit('error', error instanceof Error ? error : new Error(String(error)))
  } finally {
    importing.value = false
  }
}
watch(
  () => [props.installationId, props.profile, props.minecraftVersion, props.loader],
  () => {
    results.value = []
    selected.value = null
    localFile.value = null
    source.value = 'modrinth'
    resetInspection()
  },
)
const formatBytes = (value: number) =>
  value >= 1024 * 1024
    ? `${(value / 1024 / 1024).toFixed(1)} MiB`
    : `${Math.ceil(value / 1024)} KiB`
</script>
