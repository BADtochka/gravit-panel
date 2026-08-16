<template>
  <Card>
    <CardHeader>
      <CardTitle class="text-base">Optional mod settings</CardTitle>
      <CardDescription>
        These entries are shown in the launcher. Configure their name, description, category, and default state.
      </CardDescription>
    </CardHeader>
    <CardContent class="space-y-3">
      <p v-if="isFetching" class="py-6 text-center text-sm text-muted-foreground">Loading optional mods…</p>
      <p v-else-if="!items.length" class="py-6 text-center text-sm text-muted-foreground">
        No optional mods configured for this profile.
      </p>
      <div v-for="item in items" :key="item.projectId" class="rounded-lg border p-4">
        <div class="grid gap-3 sm:grid-cols-2">
          <div>
            <label class="text-xs font-medium">Name</label>
            <Input v-model="draft(item).name" class="mt-1" />
          </div>
          <div>
            <label class="text-xs font-medium">Category</label>
            <Input v-model="draft(item).category" class="mt-1" />
          </div>
          <div class="sm:col-span-2">
            <label class="text-xs font-medium">Description</label>
            <textarea
              v-model="draft(item).description"
              rows="2"
              class="mt-1 flex w-full rounded-md border border-input bg-transparent px-3 py-2 text-sm shadow-xs outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50"
            />
          </div>
        </div>
        <div class="mt-3 flex flex-wrap items-center justify-between gap-3">
          <label class="flex items-center gap-3 text-sm">
            <Switch v-model="draft(item).enabledByDefault" />
            Enabled by default
          </label>
          <div class="flex gap-2">
            <Button size="sm" variant="outline" :disabled="disabled" @click="save(item)">
              <Save /> Save
            </Button>
            <AlertDialog>
              <AlertDialogTrigger as-child>
                <Button size="sm" variant="destructive" :disabled="disabled"><Trash2 /> Remove</Button>
              </AlertDialogTrigger>
              <AlertDialogContent>
                <AlertDialogHeader>
                  <AlertDialogTitle>Remove {{ item.name }}?</AlertDialogTitle>
                  <AlertDialogDescription>
                    The optional file and its launcher configuration will be removed.
                  </AlertDialogDescription>
                </AlertDialogHeader>
                <AlertDialogFooter>
                  <AlertDialogCancel>Cancel</AlertDialogCancel>
                  <AlertDialogAction @click="remove(item)">Remove optional mod</AlertDialogAction>
                </AlertDialogFooter>
              </AlertDialogContent>
            </AlertDialog>
          </div>
        </div>
      </div>
    </CardContent>
  </Card>
</template>

<script setup lang="ts">
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
  AlertDialogTrigger,
} from '@/components/ui/alert-dialog'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Switch } from '@/components/ui/switch'
import type { JobRecord, OptionalMod } from '@gravit-panel/shared'
import { useQuery } from '@tanstack/vue-query'
import { Save, Trash2 } from '@lucide/vue'
import { computed, reactive, watch } from 'vue'

const props = defineProps<{
  installationId: string
  profile: string
  disabled: boolean
}>()
const emit = defineEmits<{
  job: [job: JobRecord]
  error: [error: Error]
}>()
type Draft = Pick<OptionalMod, 'name' | 'description' | 'category' | 'enabledByDefault'>
const drafts = reactive<Record<string, Draft>>({})
const request = async <T>(url: string, init?: RequestInit) => {
  const response = await fetch(url, init)
  const body = await response.json().catch(() => null) as T & { message?: string }
  if (!response.ok) throw new Error(body?.message ?? `Request failed with ${response.status}`)
  return body
}
const { data, isFetching } = useQuery({
  queryKey: computed(() => ['optional-mods', props.installationId, props.profile]),
  queryFn: () => request<{ items: OptionalMod[] }>(
    `/api/mods/optional?installationId=${encodeURIComponent(props.installationId)}` +
    `&profile=${encodeURIComponent(props.profile)}`,
  ),
  enabled: computed(() => Boolean(props.installationId && props.profile)),
})
const items = computed(() => data.value?.items ?? [])
watch(items, (value) => {
  for (const item of value) {
    drafts[item.projectId] = {
      name: item.name,
      description: item.description,
      category: item.category,
      enabledByDefault: item.enabledByDefault,
    }
  }
}, { immediate: true })
const draft = (item: OptionalMod) => drafts[item.projectId] ?? (drafts[item.projectId] = {
  name: item.name,
  description: item.description,
  category: item.category,
  enabledByDefault: item.enabledByDefault,
})
const post = (url: string, body: Record<string, unknown>) =>
  request<JobRecord>(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
const run = async (operation: () => Promise<JobRecord>) => {
  try {
    emit('job', await operation())
  } catch (error) {
    emit('error', error instanceof Error ? error : new Error(String(error)))
  }
}
const save = (item: OptionalMod) => run(() => post('/api/mods/optional/update', {
  installationId: props.installationId,
   profile: props.profile,
   projectId: item.projectId,
   filename: item.filename,
   ...draft(item),
}))
const remove = (item: OptionalMod) => run(() => post('/api/mods/optional/remove', {
  installationId: props.installationId,
  profile: props.profile,
  projectId: item.projectId,
  confirmRemoval: true,
}))
</script>
