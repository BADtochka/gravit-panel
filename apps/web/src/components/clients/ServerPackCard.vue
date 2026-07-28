<template>
  <Card>
    <CardHeader>
      <div class="flex flex-wrap items-start justify-between gap-3">
        <div>
          <CardTitle class="text-base">Server pack</CardTitle>
          <CardDescription>
            Server-only mods, plugins, and configuration files. Publish an immutable version before
            generating a bootstrap command.
          </CardDescription>
        </div>
        <Badge v-if="latestVersion" variant="secondary">v{{ latestVersion.versionNumber }}</Badge>
      </div>
    </CardHeader>
    <CardContent class="space-y-5">
      <Alert v-if="error" variant="destructive">
        <TriangleAlert class="size-4" />
        <AlertTitle>Server pack operation failed</AlertTitle>
        <AlertDescription>{{ error.message }}</AlertDescription>
      </Alert>

      <div class="grid gap-3 md:grid-cols-[1fr_1fr_auto]">
        <div>
          <label class="text-xs font-medium" for="server-pack-path">Destination path</label>
          <Input
            id="server-pack-path"
            v-model="uploadPath"
            class="mt-1"
            placeholder="config/server.properties"
          />
        </div>
        <div>
          <label class="text-xs font-medium" for="server-pack-file">Local file</label>
          <Input
            id="server-pack-file"
            class="mt-1"
            type="file"
            @change="selectFile"
          />
        </div>
        <Button
          class="self-end"
          :disabled="!selectedFile || !uploadPath || pending"
          type="button"
          @click="upload"
        >
          <Upload class="size-4" />
          Upload
        </Button>
      </div>

      <div
        v-if="profile.loader && profile.loader !== 'VANILLA'"
        class="space-y-3"
      >
        <div class="grid gap-3 md:grid-cols-[1fr_auto]">
          <div>
          <label class="text-xs font-medium" for="server-mod-slug">Search server-side Modrinth mods</label>
          <Input
            id="server-mod-slug"
            v-model="searchTerm"
            class="mt-1"
            placeholder="Search by name or paste a slug"
          />
          </div>
          <Button
            class="self-end"
            :disabled="!validSlug || pending"
            type="button"
            variant="outline"
            @click="installMod(searchTerm)"
          >
            <PackagePlus class="size-4" />
            Add slug
          </Button>
        </div>
        <div
          v-if="search?.items.length"
          class="grid gap-2 md:grid-cols-2"
        >
          <div
            v-for="project in search.items.slice(0, 6)"
            :key="project.projectId"
            class="flex items-center justify-between gap-3 rounded-md border p-3"
          >
            <div class="min-w-0">
              <p class="truncate text-sm font-medium">{{ project.title }}</p>
              <p class="truncate text-xs text-muted-foreground">
                {{ project.slug }} · server {{ project.serverSide ?? 'unknown' }}
              </p>
            </div>
            <Button
              size="sm"
              type="button"
              variant="ghost"
              :disabled="pending"
              @click="installMod(project.slug)"
            >
              Add
            </Button>
          </div>
        </div>
      </div>

      <div class="rounded-lg border">
        <div
          v-if="!pack?.items.length"
          class="p-4 text-sm text-muted-foreground"
        >
          This server pack workspace is empty.
        </div>
        <div
          v-for="file in pack?.items"
          :key="file.path"
          class="flex items-center justify-between gap-3 border-b px-4 py-3 last:border-b-0"
        >
          <div class="min-w-0">
            <p class="truncate font-mono text-xs">{{ file.path }}</p>
            <p class="text-xs text-muted-foreground">{{ formatBytes(file.size) }}</p>
          </div>
          <Button
            :disabled="pending"
            size="sm"
            type="button"
            variant="ghost"
            @click="remove(file.path)"
          >
            <Trash2 class="size-4" />
          </Button>
        </div>
      </div>
    </CardContent>
    <CardFooter class="flex flex-wrap items-center justify-between gap-3">
      <p class="text-xs text-muted-foreground">
        Published versions remain available to existing bindings.
      </p>
      <Button :disabled="pending" type="button" @click="publish">
        <Archive class="size-4" />
        Publish version
      </Button>
    </CardFooter>
  </Card>
</template>

<script setup lang="ts">
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import {
  Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle,
} from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import type {
  ClientProfileDescriptor,
  JobRecord,
  ModrinthProject,
  ServerPackFile,
  ServerPackVersion,
} from '@gravit-panel/shared'
import { useMutation, useQuery, useQueryClient } from '@tanstack/vue-query'
import { Archive, PackagePlus, Trash2, TriangleAlert, Upload } from '@lucide/vue'
import { computed, ref } from 'vue'

const props = defineProps<{
  installationId: string
  profile: ClientProfileDescriptor
  disabled: boolean
}>()
const emit = defineEmits<{ job: [job: JobRecord] }>()
const queryClient = useQueryClient()
const uploadPath = ref('')
const selectedFile = ref<File | null>(null)
const searchTerm = ref('')

const getJson = async <T>(input: RequestInfo | URL, init?: RequestInit): Promise<T> => {
  const response = await fetch(input, init)
  if (!response.ok) {
    const body = (await response.json().catch(() => null)) as { message?: string } | null
    throw new Error(body?.message ?? `Request failed with status ${response.status}`)
  }
  return response.json() as Promise<T>
}

const queryKey = computed(() => ['server-pack', props.installationId, props.profile.name])
const { data: pack, error: queryError } = useQuery({
  queryKey,
  queryFn: () => getJson<{ items: ServerPackFile[]; versions: ServerPackVersion[] }>(
    `/api/servers/profiles/${encodeURIComponent(props.profile.name)}/pack?installationId=${encodeURIComponent(props.installationId)}`,
  ),
  enabled: computed(() => Boolean(props.installationId && props.profile.name)),
})
const latestVersion = computed(() => pack.value?.versions[0] ?? null)
const { data: search } = useQuery({
  queryKey: computed(() => [
    'server-mod-search',
    props.profile.minecraftVersion,
    props.profile.loader,
    searchTerm.value,
  ]),
  queryFn: () => getJson<{ items: ModrinthProject[] }>(
    `/api/servers/modrinth/search?query=${encodeURIComponent(searchTerm.value)}` +
    `&minecraftVersion=${encodeURIComponent(props.profile.minecraftVersion!)}` +
    `&loader=${encodeURIComponent(props.profile.loader!)}`,
  ),
  enabled: computed(
    () => Boolean(
      searchTerm.value.trim().length >= 2 &&
      props.profile.minecraftVersion &&
      props.profile.loader &&
      ['FABRIC', 'FORGE', 'NEOFORGE'].includes(props.profile.loader),
    ),
  ),
  staleTime: 60_000,
})
const refresh = () => queryClient.invalidateQueries({ queryKey: queryKey.value })

const uploadMutation = useMutation({
  mutationFn: async () => {
    const form = new FormData()
    form.set('installationId', props.installationId)
    form.set('path', uploadPath.value)
    form.set('file', selectedFile.value!)
    return getJson('/api/servers/profiles/' + encodeURIComponent(props.profile.name) + '/pack/files', {
      method: 'POST',
      body: form,
    })
  },
  onSuccess: async () => {
    selectedFile.value = null
    uploadPath.value = ''
    await refresh()
  },
})
const removeMutation = useMutation({
  mutationFn: (path: string) => getJson(
    `/api/servers/profiles/${encodeURIComponent(props.profile.name)}/pack/files/remove`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        installationId: props.installationId,
        path,
        confirmRemove: true,
      }),
    },
  ),
  onSuccess: refresh,
})
const jobMutation = useMutation({
  mutationFn: (request: { path: string; body: Record<string, unknown> }) =>
    getJson<JobRecord>(request.path, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(request.body),
    }),
  onSuccess: (job) => emit('job', job),
})
const selectFile = (event: Event) => {
  selectedFile.value = (event.target as HTMLInputElement).files?.[0] ?? null
  if (selectedFile.value && !uploadPath.value) uploadPath.value = selectedFile.value.name
}
const upload = () => uploadMutation.mutate()
const remove = (path: string) => {
  if (window.confirm(`Move ${path} to recoverable server pack trash?`)) {
    removeMutation.mutate(path)
  }
}
const installMod = (slug: string) => jobMutation.mutate({
  path: `/api/servers/profiles/${encodeURIComponent(props.profile.name)}/pack/mods`,
  body: { installationId: props.installationId, slug },
})
const publish = () => jobMutation.mutate({
  path: `/api/servers/profiles/${encodeURIComponent(props.profile.name)}/pack/publish`,
  body: { installationId: props.installationId },
})
const validSlug = computed(() => /^[a-z0-9][a-z0-9_-]{0,63}$/.test(searchTerm.value))
const pending = computed(
  () => props.disabled || uploadMutation.isPending.value ||
    removeMutation.isPending.value || jobMutation.isPending.value,
)
const error = computed(
  () => (
    queryError.value || uploadMutation.error.value ||
    removeMutation.error.value || jobMutation.error.value
  ) as Error | null,
)
const formatBytes = (value: number) =>
  value < 1024 * 1024
    ? `${Math.max(1, Math.round(value / 1024))} KiB`
    : `${(value / 1024 / 1024).toFixed(1)} MiB`
</script>
