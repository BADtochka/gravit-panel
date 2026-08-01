<template>
  <section class="space-y-5">
    <div class="flex flex-wrap items-start justify-between gap-3">
      <div>
        <div class="flex flex-wrap items-center gap-2">
          <h4 class="text-sm font-semibold">Server mods &amp; files</h4>
          <Badge v-if="latestVersion" variant="secondary">v{{ latestVersion.versionNumber }}</Badge>
        </div>
        <p class="mt-1 text-xs text-muted-foreground">
          {{ totalFiles }} {{ totalFiles === 1 ? 'file' : 'files' }} · {{ formatBytes(totalSize) }}.
          Changes publish automatically but do not restart {{ serverName }}.
        </p>
      </div>
    </div>

    <Alert v-if="error" variant="destructive">
      <TriangleAlert class="size-4" />
      <AlertTitle>Server pack operation failed</AlertTitle>
      <AlertDescription>{{ error.message }}</AlertDescription>
    </Alert>

    <div class="rounded-lg bg-muted/35 p-4">
      <div class="grid gap-3 md:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_auto]">
        <div>
          <label class="text-xs font-medium" :for="pathInputId">Destination path</label>
          <Input
            :id="pathInputId"
            v-model="uploadPath"
            class="mt-1 bg-background"
            placeholder="config/server.properties"
          />
        </div>
        <div>
          <label class="text-xs font-medium" :for="fileInputId">Local file</label>
          <Input
            :id="fileInputId"
            :key="fileInputKey"
            class="mt-1 bg-background"
            type="file"
            @change="selectFile"
          />
        </div>
        <Button
          class="self-end"
          :disabled="!selectedFile || !uploadPath.trim() || pending"
          type="button"
          @click="upload"
        >
          <Upload class="size-4" />
          Upload &amp; publish
        </Button>
      </div>
      <p class="mt-2 text-[11px] text-muted-foreground">
        Uploading to an existing destination replaces that file in the newly published version.
      </p>
    </div>

    <div class="flex flex-col gap-3 sm:flex-row">
      <div class="relative flex-1">
        <Search class="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
        <Input v-model="search" class="pl-9" placeholder="Search files or folders..." aria-label="Search server files" />
      </div>
      <Select v-model="category">
        <SelectTrigger class="w-full sm:w-40" aria-label="Filter file category">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="all">All</SelectItem>
          <SelectItem value="mods">Mods</SelectItem>
          <SelectItem value="config">Config</SelectItem>
          <SelectItem value="other">Other</SelectItem>
        </SelectContent>
      </Select>
    </div>

    <div class="h-[28rem] overflow-auto rounded-lg border bg-background sm:h-[32rem]">
      <div v-if="packLoading" class="grid h-full place-items-center p-4 text-sm text-muted-foreground">
        Loading server files...
      </div>
      <div v-else-if="!pack?.items.length" class="grid h-full place-items-center p-4 text-center">
        <div>
          <FolderOpen class="mx-auto size-6 text-muted-foreground" />
          <p class="mt-3 text-sm font-medium">No server files</p>
          <p class="mt-1 text-xs text-muted-foreground">Upload a file to publish the first version.</p>
        </div>
      </div>
      <div v-else-if="!filteredFiles.length" class="grid h-full place-items-center p-4 text-center">
        <div>
          <SearchX class="mx-auto size-6 text-muted-foreground" />
          <p class="mt-3 text-sm font-medium">No matching files</p>
          <p class="mt-1 text-xs text-muted-foreground">Try another search or category.</p>
        </div>
      </div>
      <div v-else class="divide-y">
        <div
          v-for="file in filteredFiles"
          :key="file.path"
          class="flex items-center gap-3 px-3 py-2.5 sm:px-4"
        >
          <div class="grid size-8 shrink-0 place-items-center rounded-md bg-muted text-muted-foreground">
            <Package v-if="categoryFor(file.path) === 'mods'" class="size-4" />
            <FileCog v-else-if="categoryFor(file.path) === 'config'" class="size-4" />
            <File v-else class="size-4" />
          </div>
          <div class="min-w-0 flex-1">
            <div class="flex min-w-0 items-center gap-2">
              <p class="truncate text-sm font-medium">{{ filename(file.path) }}</p>
              <Badge variant="outline" class="hidden sm:inline-flex">{{ categoryLabel(file.path) }}</Badge>
            </div>
            <p class="mt-0.5 truncate font-mono text-[11px] text-muted-foreground">
              {{ folder(file.path) }}
            </p>
          </div>
          <div class="hidden shrink-0 text-right text-[11px] text-muted-foreground md:block">
            <p>{{ formatBytes(file.size) }}</p>
            <p class="mt-0.5">{{ formatModified(file.modifiedAt) }}</p>
          </div>
          <Badge variant="outline" class="shrink-0 sm:hidden">{{ categoryLabel(file.path) }}</Badge>
          <AlertDialog>
            <AlertDialogTrigger as-child>
              <Button
                :disabled="pending"
                size="icon"
                type="button"
                variant="ghost"
                :aria-label="`Remove ${file.path}`"
              >
                <Trash2 class="size-4" />
              </Button>
            </AlertDialogTrigger>
            <AlertDialogContent>
              <AlertDialogHeader>
                <AlertDialogTitle>Remove {{ file.path }}?</AlertDialogTitle>
                <AlertDialogDescription>
                  The file moves to recoverable host trash, and a new pack version is published
                  and assigned.
                </AlertDialogDescription>
              </AlertDialogHeader>
              <AlertDialogFooter>
                <AlertDialogCancel>Cancel</AlertDialogCancel>
                <AlertDialogAction @click="remove(file.path)">Move to host trash</AlertDialogAction>
              </AlertDialogFooter>
            </AlertDialogContent>
          </AlertDialog>
        </div>
      </div>
    </div>
  </section>
</template>

<script setup lang="ts">
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
  AlertDialogTrigger,
} from '@/components/ui/alert-dialog'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import type { JobRecord, ServerPackFile, ServerPackVersion } from '@gravit-panel/shared'
import { useMutation, useQuery } from '@tanstack/vue-query'
import {
  File, FileCog, FolderOpen, Package, Search, SearchX, Trash2, TriangleAlert, Upload,
} from '@lucide/vue'
import { computed, ref } from 'vue'

const props = defineProps<{
  installationId: string
  bindingId: string
  serverName: string
  disabled: boolean
}>()
const emit = defineEmits<{ job: [job: JobRecord] }>()
const uploadPath = ref('')
const selectedFile = ref<File | null>(null)
const fileInputKey = ref(0)
const search = ref('')
const category = ref<'all' | 'mods' | 'config' | 'other'>('all')

const getJson = async <T>(input: RequestInfo | URL, init?: RequestInit): Promise<T> => {
  const response = await fetch(input, init)
  if (!response.ok) {
    const body = (await response.json().catch(() => null)) as { message?: string } | null
    throw new Error(body?.message ?? `Request failed with status ${response.status}`)
  }
  return response.json() as Promise<T>
}
const queryKey = computed(() => ['server-pack', props.installationId, props.bindingId])
const { data: pack, error: queryError, isPending: packLoading } = useQuery({
  queryKey,
  queryFn: () => getJson<{ items: ServerPackFile[]; versions: ServerPackVersion[] }>(
    `/api/servers/bindings/${props.bindingId}/pack?installationId=${encodeURIComponent(props.installationId)}`,
  ),
  enabled: computed(() => Boolean(props.installationId && props.bindingId)),
})
const latestVersion = computed(() => pack.value?.versions[0] ?? null)
const totalFiles = computed(() => pack.value?.items.length ?? 0)
const totalSize = computed(() => pack.value?.items.reduce((sum, file) => sum + file.size, 0) ?? 0)
const categoryFor = (path: string): 'mods' | 'config' | 'other' => {
  const normalized = path.toLowerCase().replace(/^\.\//, '')
  if (normalized.startsWith('mods/')) return 'mods'
  if (normalized.startsWith('config/') || normalized === 'server.properties') return 'config'
  return 'other'
}
const categoryLabel = (path: string) => ({ mods: 'Mods', config: 'Config', other: 'Other' })[categoryFor(path)]
const filename = (path: string) => path.split('/').filter(Boolean).at(-1) ?? path
const folder = (path: string) => {
  const parts = path.split('/').filter(Boolean)
  return parts.length > 1 ? parts.slice(0, -1).join('/') : 'Server root'
}
const filteredFiles = computed(() => {
  const query = search.value.trim().toLowerCase()
  return (pack.value?.items ?? []).filter((file) =>
    (category.value === 'all' || categoryFor(file.path) === category.value) &&
    (!query || file.path.toLowerCase().includes(query)),
  )
})
const uploadMutation = useMutation({
  mutationFn: async () => {
    const form = new FormData()
    form.set('installationId', props.installationId)
    form.set('path', uploadPath.value.trim())
    form.set('file', selectedFile.value!)
    return getJson<JobRecord>(`/api/servers/bindings/${props.bindingId}/pack/files`, {
      method: 'POST', body: form,
    })
  },
  onSuccess: (job) => {
    selectedFile.value = null
    fileInputKey.value += 1
    uploadPath.value = ''
    emit('job', job)
  },
})
const removeMutation = useMutation({
  mutationFn: (path: string) => getJson<JobRecord>(
    `/api/servers/bindings/${props.bindingId}/pack/files/remove`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ installationId: props.installationId, path, confirmRemove: true }),
    },
  ),
  onSuccess: (job) => emit('job', job),
})
const selectFile = (event: Event) => {
  selectedFile.value = (event.target as HTMLInputElement).files?.[0] ?? null
  if (selectedFile.value && !uploadPath.value) uploadPath.value = selectedFile.value.name
}
const upload = () => uploadMutation.mutate()
const remove = (path: string) => removeMutation.mutate(path)
const pending = computed(() => props.disabled || uploadMutation.isPending.value || removeMutation.isPending.value)
const error = computed(() => (queryError.value || uploadMutation.error.value || removeMutation.error.value) as Error | null)
const safeBindingId = computed(() => props.bindingId.replace(/[^a-zA-Z0-9_-]/g, '-'))
const pathInputId = computed(() => `server-pack-path-${safeBindingId.value}`)
const fileInputId = computed(() => `server-pack-file-${safeBindingId.value}`)
const formatBytes = (value: number) => {
  if (!value) return '0 B'
  if (value < 1024) return `${value} B`
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(value < 10 * 1024 ? 1 : 0)} KiB`
  return `${(value / 1024 / 1024).toFixed(1)} MiB`
}
const formatModified = (value: string) => new Intl.DateTimeFormat(undefined, {
  dateStyle: 'medium', timeStyle: 'short',
}).format(new Date(value))
</script>
