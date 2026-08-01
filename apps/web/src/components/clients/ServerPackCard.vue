<template>
  <section class="space-y-5 border-t pt-4">
    <div class="flex flex-wrap items-start justify-between gap-3">
      <div>
        <h4 class="text-sm font-semibold">Server pack</h4>
        <p class="text-xs text-muted-foreground">
          Files for {{ serverName }}. Every change publishes and assigns an immutable version.
        </p>
      </div>
      <Badge v-if="latestVersion" variant="secondary">v{{ latestVersion.versionNumber }}</Badge>
    </div>
    <div class="space-y-5">
      <Alert v-if="error" variant="destructive">
        <TriangleAlert class="size-4" />
        <AlertTitle>Server pack operation failed</AlertTitle>
        <AlertDescription>{{ error.message }}</AlertDescription>
      </Alert>

      <div class="grid gap-3 md:grid-cols-[1fr_1fr_auto]">
        <div>
          <label class="text-xs font-medium" :for="pathInputId">Destination path</label>
          <Input
            :id="pathInputId"
            v-model="uploadPath"
            class="mt-1"
            placeholder="config/server.properties"
          />
        </div>
        <div>
          <label class="text-xs font-medium" :for="fileInputId">Local file</label>
          <Input
            :id="fileInputId"
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

      <div class="h-[60vh] max-h-[32rem] overflow-auto border-y md:h-[32rem]">
        <div
          v-if="packLoading"
          class="grid h-full place-items-center p-4 text-sm text-muted-foreground"
        >
          Loading server pack...
        </div>
        <div
          v-else-if="!pack?.items.length"
          class="grid h-full place-items-center p-4 text-center text-sm text-muted-foreground"
        >
          This server pack workspace is empty.
        </div>
        <div v-else class="divide-y">
          <div
            v-for="file in pack.items"
            :key="file.path"
            class="flex items-center justify-between gap-3 px-4 py-3"
          >
            <div class="min-w-0">
              <p class="truncate font-mono text-xs">{{ file.path }}</p>
              <p class="text-xs text-muted-foreground">{{ formatBytes(file.size) }}</p>
            </div>
            <AlertDialog>
              <AlertDialogTrigger as-child>
                <Button :disabled="pending" size="sm" type="button" variant="ghost">
                  <Trash2 class="size-4" />
                </Button>
              </AlertDialogTrigger>
              <AlertDialogContent>
                <AlertDialogHeader>
                  <AlertDialogTitle>Remove {{ file.path }}?</AlertDialogTitle>
                  <AlertDialogDescription>
                    The file moves to recoverable trash and a new pack version is assigned.
                  </AlertDialogDescription>
                </AlertDialogHeader>
                <AlertDialogFooter>
                  <AlertDialogCancel>Cancel</AlertDialogCancel>
                  <AlertDialogAction @click="remove(file.path)">Move to trash</AlertDialogAction>
                </AlertDialogFooter>
              </AlertDialogContent>
            </AlertDialog>
          </div>
        </div>
      </div>
    </div>
    <div>
      <p class="text-xs text-muted-foreground">
        Latest desired version: {{ latestVersion ? `v${latestVersion.versionNumber}` : 'empty' }}.
        The installed updater applies files without restarting the server. Restart it manually to
        load mod changes.
      </p>
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
import type {
  JobRecord,
  ServerPackFile,
  ServerPackVersion,
} from '@gravit-panel/shared'
import { useMutation, useQuery } from '@tanstack/vue-query'
import { Trash2, TriangleAlert, Upload } from '@lucide/vue'
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
const uploadMutation = useMutation({
  mutationFn: async () => {
    const form = new FormData()
    form.set('installationId', props.installationId)
    form.set('path', uploadPath.value)
    form.set('file', selectedFile.value!)
    return getJson<JobRecord>(`/api/servers/bindings/${props.bindingId}/pack/files`, {
      method: 'POST',
      body: form,
    })
  },
  onSuccess: async (job) => {
    selectedFile.value = null
    uploadPath.value = ''
    emit('job', job)
  },
})
const removeMutation = useMutation({
  mutationFn: (path: string) => getJson<JobRecord>(
    `/api/servers/bindings/${props.bindingId}/pack/files/remove`,
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
  onSuccess: (job) => emit('job', job),
})
const selectFile = (event: Event) => {
  selectedFile.value = (event.target as HTMLInputElement).files?.[0] ?? null
  if (selectedFile.value && !uploadPath.value) uploadPath.value = selectedFile.value.name
}
const upload = () => uploadMutation.mutate()
const remove = (path: string) => removeMutation.mutate(path)
const pending = computed(
  () => props.disabled || uploadMutation.isPending.value ||
    removeMutation.isPending.value,
)
const error = computed(
  () => (
    queryError.value || uploadMutation.error.value ||
    removeMutation.error.value
  ) as Error | null,
)
const safeBindingId = computed(() => props.bindingId.replace(/[^a-zA-Z0-9_-]/g, '-'))
const pathInputId = computed(() => `server-pack-path-${safeBindingId.value}`)
const fileInputId = computed(() => `server-pack-file-${safeBindingId.value}`)
const formatBytes = (value: number) =>
  value < 1024 * 1024
    ? `${Math.max(1, Math.round(value / 1024))} KiB`
    : `${(value / 1024 / 1024).toFixed(1)} MiB`
</script>
