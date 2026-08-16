<template>
  <section class="space-y-4">
    <div class="flex flex-wrap items-start justify-between gap-3">
      <div>
        <div class="flex flex-wrap items-center gap-2">
          <h4 class="text-sm font-semibold">{{ title }}</h4>
          <Badge variant="secondary">Live</Badge>
        </div>
        <p class="mt-1 text-xs text-muted-foreground">
          {{ totalFiles }} files · {{ formatBytes(totalSize) }} in this folder. Changes apply immediately to {{ serverName }}.
        </p>
      </div>
      <div class="flex flex-wrap gap-2">
        <Button size="sm" variant="outline" :disabled="pending" @click="openCreate('directory')">
          <FolderPlus /> New folder
        </Button>
        <Button size="sm" variant="outline" :disabled="pending" @click="openCreate('file')">
          <FilePlus2 /> New file
        </Button>
        <Button size="sm" :disabled="pending" @click="fileInput?.click()">
          <Upload /> Upload
        </Button>
        <input ref="fileInput" class="hidden" type="file" @change="uploadFile">
      </div>
    </div>

    <Alert v-if="error" variant="destructive">
      <TriangleAlert class="size-4" />
      <AlertTitle>Live filesystem operation failed</AlertTitle>
      <AlertDescription>{{ error.message }}</AlertDescription>
    </Alert>

    <div class="overflow-hidden rounded-xl border bg-background shadow-sm">
      <div class="flex flex-wrap items-center gap-2 border-b bg-muted/20 p-3">
        <Button size="icon" variant="ghost" :disabled="!currentDirectory" aria-label="Go up" @click="goUp">
          <ArrowUp />
        </Button>
        <nav class="flex min-w-0 flex-1 items-center gap-1 overflow-x-auto" aria-label="Current directory">
          <Button size="sm" variant="ghost" class="shrink-0 px-2" @click="navigate('')">
            <HardDrive class="size-4" /> {{ rootLabel }}
          </Button>
          <template v-for="crumb in breadcrumbs" :key="crumb.path">
            <ChevronRight class="size-3.5 shrink-0 text-muted-foreground" />
            <Button size="sm" variant="ghost" class="shrink-0 px-2" @click="navigate(crumb.path)">{{ crumb.name }}</Button>
          </template>
        </nav>
        <div class="relative w-full sm:w-64">
          <Search class="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input v-model="search" class="h-9 pl-9" placeholder="Search this folder..." />
        </div>
      </div>

      <div v-if="selectedPaths.length" class="flex flex-wrap items-center justify-between gap-3 border-b bg-primary/5 px-4 py-2.5">
        <p class="text-sm font-medium">{{ selectedPaths.length }} selected</p>
        <div class="flex gap-2">
          <Button v-if="selectedPaths.length === 1" size="sm" variant="outline" :disabled="pending" @click="openRename">
            <Pencil /> Rename / move
          </Button>
          <Button size="sm" variant="destructive" :disabled="pending" @click="requestDeleteSelected">
            <Trash2 /> Delete
          </Button>
          <Button size="sm" variant="ghost" @click="selectedPaths = []">Clear</Button>
        </div>
      </div>

      <div class="h-[34rem] max-w-full overflow-auto overscroll-contain">
        <div v-if="packLoading" class="grid h-full min-w-[40rem] place-items-center text-sm text-muted-foreground">Loading live files...</div>
        <div v-else-if="!visibleEntries.length" class="grid h-full min-w-[40rem] place-items-center p-8 text-center">
          <div>
            <FolderOpen class="mx-auto size-8 text-muted-foreground" />
            <p class="mt-3 text-sm font-medium">{{ search ? 'No matching entries' : 'This folder is empty' }}</p>
            <p class="mt-1 text-xs text-muted-foreground">Create a file or upload content into this directory.</p>
          </div>
        </div>
        <table v-else class="w-full min-w-[48rem] table-fixed text-sm">
          <thead class="sticky top-0 z-10 border-b bg-background/95 text-left text-xs text-muted-foreground backdrop-blur">
            <tr>
              <th class="w-11 px-3 py-2.5"><Checkbox :model-value="allVisibleSelected" aria-label="Select all" @update:model-value="toggleAll" /></th>
              <th class="px-2 py-2.5 font-medium">Name</th>
              <th class="hidden w-28 px-3 py-2.5 font-medium md:table-cell">Type</th>
              <th class="hidden w-28 px-3 py-2.5 font-medium sm:table-cell">Size</th>
              <th class="hidden w-44 px-3 py-2.5 font-medium lg:table-cell">Modified</th>
              <th class="w-12 px-3 py-2.5" />
            </tr>
          </thead>
          <tbody class="divide-y">
            <tr
              v-for="entry in visibleEntries"
              :key="entry.path"
              class="group cursor-pointer hover:bg-muted/40"
              :class="{ 'bg-primary/5': selectedPaths.includes(entry.path) }"
              @click="openEntry(entry)"
              @contextmenu.prevent.stop="openEntryMenu($event, entry)"
            >
              <td class="px-3 py-2.5">
                <Checkbox :model-value="selectedPaths.includes(entry.path)" :aria-label="`Select ${entryName(entry)}`" @click.stop @update:model-value="toggleSelection(entry.path)" />
              </td>
              <td class="min-w-0 px-2 py-2.5">
                <div class="flex w-full min-w-0 items-center gap-3 text-left">
                  <Folder v-if="entry.type === 'directory'" class="size-5 shrink-0 fill-amber-400/20 text-amber-500" />
                  <Package v-else-if="entry.path.toLowerCase().endsWith('.jar')" class="size-5 shrink-0 text-violet-500" />
                  <FileCode2 v-else-if="editable(entry.path)" class="size-5 shrink-0 text-sky-500" />
                  <File v-else class="size-5 shrink-0 text-muted-foreground" />
                  <span class="min-w-0">
                    <span class="block truncate font-medium">{{ entryName(entry) }}</span>
                    <span v-if="search" class="block truncate font-mono text-[10px] text-muted-foreground">{{ entry.path }}</span>
                    <span class="block text-[11px] text-muted-foreground md:hidden">{{ entry.type === 'directory' ? 'Folder' : formatBytes(entry.size ?? 0) }}</span>
                  </span>
                </div>
              </td>
              <td class="hidden px-3 py-2.5 text-xs text-muted-foreground md:table-cell">{{ entryType(entry) }}</td>
              <td class="hidden px-3 py-2.5 font-mono text-xs text-muted-foreground sm:table-cell">{{ entry.size === null ? '—' : formatBytes(entry.size) }}</td>
              <td class="hidden px-3 py-2.5 text-xs text-muted-foreground lg:table-cell">{{ formatModified(entry.modifiedAt) }}</td>
              <td class="px-3 py-2.5">
                <Button size="icon" variant="ghost" aria-label="Entry actions" @click.stop="openEntryMenu($event, entry)"><EllipsisVertical /></Button>
              </td>
            </tr>
          </tbody>
        </table>
      </div>
    </div>

    <Teleport to="body">
      <div
        v-if="entryMenu"
        class="fixed z-[80] w-48 overflow-hidden rounded-md border bg-popover p-1 text-popover-foreground shadow-lg"
        :style="{ left: `${entryMenu.x}px`, top: `${entryMenu.y}px` }"
        role="menu"
        @click.stop
      >
        <button class="flex w-full items-center gap-2 rounded-sm px-2 py-2 text-left text-sm hover:bg-accent" role="menuitem" @click="openMenuEntry">
          <FolderOpen v-if="entryMenu.entry.type === 'directory'" class="size-4" />
          <FileCode2 v-else class="size-4" />
          Open
        </button>
        <button class="flex w-full items-center gap-2 rounded-sm px-2 py-2 text-left text-sm hover:bg-accent" role="menuitem" @click="renameMenuEntry">
          <Pencil class="size-4" /> Rename / move
        </button>
        <div class="my-1 h-px bg-border" />
        <button class="flex w-full items-center gap-2 rounded-sm px-2 py-2 text-left text-sm text-destructive hover:bg-destructive/10" role="menuitem" @click="deleteMenuEntry">
          <Trash2 class="size-4" /> Move to trash
        </button>
      </div>
    </Teleport>

    <Dialog :open="editorOpen" @update:open="setEditorOpen">
      <DialogContent class="flex h-dvh w-screen !max-w-none flex-col gap-0 overflow-hidden rounded-none border-0 p-0 sm:h-[min(92vh,64rem)] sm:w-[min(96vw,96rem)] sm:!max-w-[96rem] sm:rounded-xl sm:border lg:w-[min(94vw,96rem)]">
        <DialogHeader class="shrink-0 gap-1 border-b px-3 py-3 pr-11 text-left sm:px-5 sm:py-4 sm:pr-12">
          <div class="flex min-w-0 items-center gap-2">
            <FileCode2 class="size-4 shrink-0" />
            <DialogTitle class="min-w-0 flex-1 truncate font-mono text-xs sm:text-sm">{{ activeFile?.path }}</DialogTitle>
            <Badge v-if="editorDirty" variant="outline" class="shrink-0">Unsaved</Badge>
          </div>
          <DialogDescription v-if="activeFile" class="truncate text-[10px] sm:text-xs">
            {{ formatBytes(activeFile.size ?? 0) }} · {{ formatModified(activeFile.modifiedAt) }}
          </DialogDescription>
        </DialogHeader>
        <div v-if="activeEditable" class="flex min-h-0 flex-1 overflow-hidden">
          <div v-if="textLoading" class="grid flex-1 place-items-center text-sm text-muted-foreground">Loading file...</div>
          <CodeEditor v-else v-model="editorContent" :disabled="pending" @save="saveText" />
        </div>
        <div v-else class="grid min-h-0 flex-1 place-items-center overflow-auto p-8 text-center">
          <div><Package class="mx-auto size-8 text-muted-foreground" /><p class="mt-3 text-sm font-medium">Preview unavailable</p><p class="mt-1 text-xs text-muted-foreground">Binary files can be replaced through Upload or moved and deleted.</p></div>
        </div>
        <DialogFooter class="grid shrink-0 grid-cols-2 gap-2 border-t bg-muted/20 px-3 pt-2 pb-[max(0.5rem,env(safe-area-inset-bottom))] sm:flex sm:px-5 sm:py-3">
          <Button v-if="activeEditable" size="sm" variant="outline" :disabled="pending || !editorDirty" @click="discardText">Discard</Button>
          <Button size="sm" variant="outline" :class="{ 'col-span-2': !activeEditable }" @click="closeEditor">Close</Button>
          <Button v-if="activeEditable" size="sm" class="col-span-2 sm:col-span-1" :disabled="pending || !editorDirty" @click="saveText"><Save />Save</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>

    <Dialog v-model:open="createOpen">
      <DialogContent>
        <DialogHeader><DialogTitle>{{ createKind === 'directory' ? 'Create folder' : 'Create file' }}</DialogTitle><DialogDescription>Created immediately inside <span class="font-mono">/{{ currentDirectory }}</span>.</DialogDescription></DialogHeader>
        <div><label class="text-sm font-medium" for="new-entry-name">Name</label><Input id="new-entry-name" v-model="createName" class="mt-2" :placeholder="createKind === 'directory' ? 'plugins' : 'server.properties'" @keyup.enter="createEntry" /></div>
        <DialogFooter><Button variant="outline" @click="createOpen = false">Cancel</Button><Button :disabled="!validEntryName || pending" @click="createEntry">Create</Button></DialogFooter>
      </DialogContent>
    </Dialog>

    <Dialog v-model:open="renameOpen">
      <DialogContent>
        <DialogHeader><DialogTitle>Rename or move entry</DialogTitle><DialogDescription>Enter a full path relative to the server root. Existing entries are never overwritten.</DialogDescription></DialogHeader>
        <div><label class="text-sm font-medium" for="destination-path">Destination path</label><Input id="destination-path" v-model="destinationPath" class="mt-2 font-mono" @keyup.enter="moveEntry" /></div>
        <DialogFooter><Button variant="outline" @click="renameOpen = false">Cancel</Button><Button :disabled="!destinationPath.trim() || pending" @click="moveEntry">Move</Button></DialogFooter>
      </DialogContent>
    </Dialog>

    <AlertDialog v-model:open="deleteOpen">
      <AlertDialogContent>
        <AlertDialogHeader><AlertDialogTitle>Delete {{ deletePaths.length }} selected item{{ deletePaths.length === 1 ? '' : 's' }}?</AlertDialogTitle><AlertDialogDescription>Folders are moved recursively to protected trash. The running service sees the change immediately.</AlertDialogDescription></AlertDialogHeader>
        <AlertDialogFooter><AlertDialogCancel>Cancel</AlertDialogCancel><AlertDialogAction @click="deleteSelected">Move to trash</AlertDialogAction></AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  </section>
</template>

<script setup lang="ts">
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from '@/components/ui/alert-dialog'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { panelFetch } from '@/lib/public-path'
import type { ServerPackEntry, ServerPackTextFile } from '@gravit-panel/shared'
import { useMutation, useQuery, useQueryClient } from '@tanstack/vue-query'
import { ArrowUp, ChevronRight, EllipsisVertical, File, FileCode2, FilePlus2, Folder, FolderOpen, FolderPlus, HardDrive, Package, Pencil, Save, Search, Trash2, TriangleAlert, Upload } from '@lucide/vue'
import { computed, defineAsyncComponent, onBeforeUnmount, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'

const CodeEditor = defineAsyncComponent(() => import('@/components/servers/CodeEditor.vue'))
const props = withDefaults(defineProps<{
  installationId: string
  bindingId?: string
  serverName: string
  disabled: boolean
  endpointBase?: string
  title?: string
  rootLabel?: string
}>(), {
  bindingId: '',
  endpointBase: '',
  title: 'Live server files',
  rootLabel: 'Server',
})
const queryClient = useQueryClient()
const route = useRoute()
const router = useRouter()
const initialDirectory = typeof route.query.path === 'string' && !route.query.path.startsWith('/') && !route.query.path.includes('..')
  ? route.query.path.replace(/^\/+|\/+$/g, '')
  : ''
const currentDirectory = ref(initialDirectory)
const search = ref('')
const selectedPaths = ref<string[]>([])
const activePath = ref('')
const editorOpen = ref(false)
const editorContent = ref('')
const savedContent = ref('')
const fileInput = ref<HTMLInputElement | null>(null)
const createOpen = ref(false)
const createKind = ref<'file' | 'directory'>('file')
const createName = ref('')
const renameOpen = ref(false)
const destinationPath = ref('')
const deleteOpen = ref(false)
const deletePaths = ref<string[]>([])
const renameSourcePath = ref('')
const entryMenu = ref<{ entry: ServerPackEntry; x: number; y: number } | null>(null)

const getJson = async <T>(input: RequestInfo | URL, init?: RequestInit): Promise<T> => {
  const response = await panelFetch(input, init)
  const body = (await response.json().catch(() => null)) as T | { message?: string } | null
  if (!response.ok) throw new Error(body && typeof body === 'object' && 'message' in body && body.message ? body.message : `Request failed with status ${response.status}`)
  return body as T
}
const filesEndpoint = computed(() => props.endpointBase || `/api/servers/bindings/${props.bindingId}/files`)
const cacheScope = computed(() => ['live-files', filesEndpoint.value, props.installationId])
const queryKey = computed(() => [...cacheScope.value, currentDirectory.value])
const { data: pack, error: queryError, isPending: packLoading } = useQuery({
  queryKey,
  queryFn: () => getJson<{ path: string; entries: ServerPackEntry[] }>(`${filesEndpoint.value}?installationId=${encodeURIComponent(props.installationId)}&path=${encodeURIComponent(currentDirectory.value)}`),
  enabled: computed(() => Boolean(props.installationId && filesEndpoint.value)),
})
const entries = computed(() => pack.value?.entries ?? [])
const totalFiles = computed(() => entries.value.filter((entry) => entry.type === 'file').length)
const totalSize = computed(() => entries.value.reduce((sum, entry) => sum + (entry.size ?? 0), 0))
const editableExtensions = new Set(['txt', 'json', 'json5', 'toml', 'yaml', 'yml', 'properties', 'conf', 'cfg', 'ini', 'xml', 'sh', 'bat', 'cmd', 'js', 'ts', 'md', 'log'])
const editable = (path: string) => editableExtensions.has(path.split('.').at(-1)?.toLowerCase() ?? '')
const parentPath = (path: string) => path.split('/').slice(0, -1).join('/')
const entryName = (entry: ServerPackEntry) => entry.path.split('/').at(-1) ?? entry.path
const visibleEntries = computed(() => {
  const query = search.value.trim().toLowerCase()
  const result = entries.value.filter((entry) => !query || entry.path.toLowerCase().includes(query))
  return result.sort((left, right) => Number(right.type === 'directory') - Number(left.type === 'directory') || entryName(left).localeCompare(entryName(right)))
})
const breadcrumbs = computed(() => currentDirectory.value.split('/').filter(Boolean).map((name, index, parts) => ({ name, path: parts.slice(0, index + 1).join('/') })))
const allVisibleSelected = computed(() => Boolean(visibleEntries.value.length && visibleEntries.value.every((entry) => selectedPaths.value.includes(entry.path))))
const activeFile = computed(() => entries.value.find((entry) => entry.type === 'file' && entry.path === activePath.value) ?? null)
const activeEditable = computed(() => Boolean(activeFile.value && editable(activeFile.value.path)))
const textQuery = useQuery({
  queryKey: computed(() => [...cacheScope.value, 'file', activePath.value]),
  queryFn: () => getJson<ServerPackTextFile>(`${filesEndpoint.value}/file?installationId=${encodeURIComponent(props.installationId)}&path=${encodeURIComponent(activePath.value)}`),
  enabled: activeEditable,
})
watch(() => textQuery.data.value, (value) => { if (value?.path === activePath.value) { editorContent.value = value.content; savedContent.value = value.content } }, { immediate: true })
const editorDirty = computed(() => editorContent.value !== savedContent.value)
const textLoading = computed(() => textQuery.isFetching.value)
const confirmDiscard = () => !editorDirty.value || window.confirm('Discard unsaved file changes?')
const navigate = (path: string) => {
  if (!confirmDiscard()) return
  currentDirectory.value = path
  search.value = ''
  selectedPaths.value = []
  activePath.value = ''
  void router.replace({ query: { ...route.query, path: path || undefined } })
}
const goUp = () => navigate(parentPath(currentDirectory.value))
const openEntry = (entry: ServerPackEntry) => {
  if (entry.type === 'directory') navigate(entry.path)
  else if (confirmDiscard()) { activePath.value = entry.path; editorOpen.value = true }
}
const closeEditor = () => { if (confirmDiscard()) { editorOpen.value = false; activePath.value = '' } }
const setEditorOpen = (open: boolean) => { if (open) editorOpen.value = true; else closeEditor() }
const toggleSelection = (path: string) => { selectedPaths.value = selectedPaths.value.includes(path) ? selectedPaths.value.filter((item) => item !== path) : [...selectedPaths.value, path] }
const toggleAll = () => { selectedPaths.value = allVisibleSelected.value ? selectedPaths.value.filter((path) => !visibleEntries.value.some((entry) => entry.path === path)) : [...new Set([...selectedPaths.value, ...visibleEntries.value.map((entry) => entry.path)])] }
const operationMutation = useMutation({
  mutationFn: (body: Record<string, unknown>) => getJson(`${filesEndpoint.value}/operations`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ installationId: props.installationId, ...body }) }),
  onSuccess: () => queryClient.invalidateQueries({ queryKey: cacheScope.value }),
})
const uploadMutation = useMutation({
  mutationFn: async ({ file, path, overwrite }: { file: File; path: string; overwrite: boolean }) => { const form = new FormData(); form.set('installationId', props.installationId); form.set('path', path); form.set('overwrite', String(overwrite)); form.set('file', file); return getJson(`${filesEndpoint.value}/upload`, { method: 'POST', body: form }) },
  onSuccess: () => queryClient.invalidateQueries({ queryKey: cacheScope.value }),
})
const saveMutation = useMutation({
  mutationFn: ({ path, content, overwrite }: { path: string; content: string; overwrite: boolean }) => getJson(`${filesEndpoint.value}/file`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ installationId: props.installationId, path, content, overwrite }) }),
  onSuccess: () => { savedContent.value = editorContent.value; void queryClient.invalidateQueries({ queryKey: cacheScope.value }) },
})
const pending = computed(() => props.disabled || operationMutation.isPending.value || uploadMutation.isPending.value || saveMutation.isPending.value)
const error = computed(() => (queryError.value || textQuery.error.value || operationMutation.error.value || uploadMutation.error.value || saveMutation.error.value) as Error | null)
const openCreate = (kind: 'file' | 'directory') => { createKind.value = kind; createName.value = ''; createOpen.value = true }
const validEntryName = computed(() => Boolean(createName.value.trim() && !/[\\/\0]/.test(createName.value) && !['.', '..'].includes(createName.value.trim())))
const joinPath = (directory: string, name: string) => [directory, name].filter(Boolean).join('/')
const createEntry = () => { if (!validEntryName.value) return; const path = joinPath(currentDirectory.value, createName.value.trim()); if (createKind.value === 'directory') operationMutation.mutate({ action: 'mkdir', path }, { onSuccess: () => { createOpen.value = false } }); else saveMutation.mutate({ path, content: '', overwrite: false }, { onSuccess: () => { createOpen.value = false } }) }
const openRename = (path = selectedPaths.value[0] ?? '') => { if (!path) return; renameSourcePath.value = path; destinationPath.value = path; renameOpen.value = true }
const moveEntry = () => { const sourcePath = renameSourcePath.value; const destination = destinationPath.value.trim(); if (!sourcePath || !destination || sourcePath === destination) return; operationMutation.mutate({ action: 'move', sourcePath, destinationPath: destination }, { onSuccess: () => { if (activePath.value === sourcePath) activePath.value = ''; selectedPaths.value = selectedPaths.value.filter((path) => path !== sourcePath); renameOpen.value = false } }) }
const requestDeleteSelected = () => { deletePaths.value = [...selectedPaths.value]; deleteOpen.value = true }
const deleteSelected = () => { const paths = [...deletePaths.value]; if (!paths.length) return; operationMutation.mutate({ action: 'delete', paths, confirmRemove: true }, { onSuccess: () => { if (paths.some((path) => activePath.value === path || activePath.value.startsWith(`${path}/`))) activePath.value = ''; selectedPaths.value = selectedPaths.value.filter((path) => !paths.includes(path)); deleteOpen.value = false; deletePaths.value = [] } }) }
const openEntryMenu = (event: MouseEvent, entry: ServerPackEntry) => {
  const width = 192
  const height = 132
  entryMenu.value = {
    entry,
    x: Math.max(8, Math.min(event.clientX, window.innerWidth - width - 8)),
    y: Math.max(8, Math.min(event.clientY, window.innerHeight - height - 8)),
  }
}
const openMenuEntry = () => { const entry = entryMenu.value?.entry; entryMenu.value = null; if (entry) openEntry(entry) }
const renameMenuEntry = () => { const path = entryMenu.value?.entry.path; entryMenu.value = null; if (path) openRename(path) }
const deleteMenuEntry = () => { const path = entryMenu.value?.entry.path; entryMenu.value = null; if (path) { deletePaths.value = [path]; deleteOpen.value = true } }
const uploadFile = (event: Event) => {
  const input = event.target as HTMLInputElement
  const file = input.files?.[0]
  input.value = ''
  if (!file) return
  const path = joinPath(currentDirectory.value, file.name)
  if (entries.value.some((entry) => entry.path === path) && !window.confirm(`Replace ${path}?`)) return
  if (file.size > 64 * 1024 * 1024) { window.alert('Live uploads currently support files up to 64 MiB.'); return }
  uploadMutation.mutate({ file, path, overwrite: entries.value.some((entry) => entry.path === path) })
}
const saveText = () => { if (editorDirty.value && !pending.value) saveMutation.mutate({ path: activePath.value, content: editorContent.value, overwrite: true }) }
const discardText = () => { editorContent.value = savedContent.value }
const entryType = (entry: ServerPackEntry) => entry.type === 'directory' ? 'Folder' : entry.path.toLowerCase().endsWith('.jar') ? 'Java archive' : editable(entry.path) ? 'Text file' : 'File'
const formatBytes = (value: number) => value < 1024 ? `${value} B` : value < 1024 * 1024 ? `${(value / 1024).toFixed(value < 10 * 1024 ? 1 : 0)} KiB` : `${(value / 1024 / 1024).toFixed(1)} MiB`
const formatModified = (value: string) => new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(value))
const beforeUnload = (event: BeforeUnloadEvent) => { if (editorDirty.value) event.preventDefault() }
const closeEntryMenu = (event: KeyboardEvent | MouseEvent) => { if (!(event instanceof KeyboardEvent) || event.key === 'Escape') entryMenu.value = null }
window.addEventListener('beforeunload', beforeUnload)
window.addEventListener('click', closeEntryMenu)
window.addEventListener('keydown', closeEntryMenu)
onBeforeUnmount(() => { window.removeEventListener('beforeunload', beforeUnload); window.removeEventListener('click', closeEntryMenu); window.removeEventListener('keydown', closeEntryMenu) })
</script>
