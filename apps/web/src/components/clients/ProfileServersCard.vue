<template>
  <Card>
    <CardHeader>
      <div class="flex flex-wrap items-start justify-between gap-3">
        <div>
          <CardTitle class="text-base">Game servers</CardTitle>
          <CardDescription>
            Bind dedicated servers to this profile and generate a one-time Linux bootstrap command.
          </CardDescription>
        </div>
        <Button type="button" variant="outline" @click="startCreate">
          <Plus class="size-4" />
          Add server
        </Button>
      </div>
    </CardHeader>
    <CardContent class="space-y-4">
      <Alert variant="destructive">
        <ShieldAlert class="size-4" />
        <AlertTitle>Native LaunchServer token cannot be revoked separately</AlertTitle>
        <AlertDescription>
          It is profile-scoped, has no expiry, and is written by the native token command to
          LaunchServer logs. Rotate LaunchServer keys if it is exposed.
        </AlertDescription>
      </Alert>
      <Alert v-if="error" variant="destructive">
        <TriangleAlert class="size-4" />
        <AlertTitle>Server operation failed</AlertTitle>
        <AlertDescription>{{ error.message }}</AlertDescription>
      </Alert>

      <div v-if="editing" class="grid gap-4 rounded-lg border p-4 md:grid-cols-2">
        <div>
          <label class="text-xs font-medium" for="binding-name">Server name</label>
          <Input id="binding-name" v-model="form.name" class="mt-1" maxlength="64" />
        </div>
        <div>
          <label class="text-xs font-medium" for="binding-address">Public address</label>
          <Input id="binding-address" v-model="form.serverAddress" class="mt-1" />
        </div>
        <div>
          <label class="text-xs font-medium" for="binding-port">Port</label>
          <Input id="binding-port" v-model.number="form.serverPort" class="mt-1" type="number" />
        </div>
        <div>
          <label class="text-xs font-medium" for="binding-auth">Auth provider</label>
          <Select v-model="form.authId">
            <SelectTrigger id="binding-auth" class="mt-1 w-full"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem v-for="provider in auth?.providers" :key="provider.id" :value="provider.id">
                {{ provider.displayName }} ({{ provider.id }})
              </SelectItem>
            </SelectContent>
          </Select>
        </div>
        <div>
          <label class="text-xs font-medium" for="binding-pack">Server pack version</label>
          <Select v-model="packSelection">
            <SelectTrigger id="binding-pack" class="mt-1 w-full"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="none">No server pack</SelectItem>
              <SelectItem v-for="version in pack?.versions" :key="version.id" :value="version.id">
                v{{ version.versionNumber }} · {{ version.fileCount }} files
              </SelectItem>
            </SelectContent>
          </Select>
        </div>
        <div class="grid grid-cols-2 gap-3">
          <div>
            <label class="text-xs font-medium" for="binding-xms">Xms</label>
            <Input id="binding-xms" v-model="form.xms" class="mt-1" placeholder="1G" />
          </div>
          <div>
            <label class="text-xs font-medium" for="binding-xmx">Xmx</label>
            <Input id="binding-xmx" v-model="form.xmx" class="mt-1" placeholder="4G" />
          </div>
        </div>
        <div class="md:col-span-2">
          <label class="text-xs font-medium" for="binding-jvm">Additional JVM arguments</label>
          <Input id="binding-jvm" v-model="jvmArgs" class="mt-1" placeholder="-XX:+UseG1GC" />
        </div>
        <div class="md:col-span-2">
          <label class="text-xs font-medium" for="binding-game">Game arguments</label>
          <Input id="binding-game" v-model="gameArgs" class="mt-1" placeholder="nogui" />
        </div>
        <label class="flex items-center gap-2 text-sm">
          <Checkbox
            :checked="form.isDefault"
            @update:checked="form.isDefault = Boolean($event)"
          />
          Default server
        </label>
        <div class="flex justify-end gap-2 md:col-span-2">
          <Button type="button" variant="ghost" @click="editing = null">Cancel</Button>
          <Button :disabled="!canSave || pending" type="button" @click="save">
            <Save class="size-4" />
            {{ editing === 'new' ? 'Bind server' : 'Save changes' }}
          </Button>
        </div>
      </div>

      <div class="rounded-lg border">
        <div v-if="!bindings?.items.length" class="p-4 text-sm text-muted-foreground">
          No servers are attached to this profile.
        </div>
        <div
          v-for="binding in bindings?.items"
          :key="binding.id ?? binding.name"
          class="space-y-3 border-b p-4 last:border-b-0"
        >
          <div class="flex flex-wrap items-start justify-between gap-3">
            <div>
              <div class="flex flex-wrap items-center gap-2">
                <p class="font-medium">{{ binding.name }}</p>
                <Badge v-if="binding.isDefault" variant="secondary">Default</Badge>
                <Badge :variant="binding.managed ? 'outline' : 'destructive'">
                  {{ binding.managed ? binding.deploymentState : 'Legacy' }}
                </Badge>
              </div>
              <p class="mt-1 text-xs text-muted-foreground">
                {{ binding.serverAddress }}:{{ binding.serverPort }}
              </p>
            </div>
            <div class="flex flex-wrap gap-2">
              <Button
                v-if="!binding.managed"
                size="sm"
                type="button"
                variant="outline"
                @click="adopt(binding)"
              >
                <Plus class="size-4" />
                Adopt
              </Button>
              <Button
                v-if="binding.managed"
                size="sm"
                type="button"
                variant="outline"
                @click="edit(binding)"
              >
                <Pencil class="size-4" />
                Edit
              </Button>
              <Button
                v-if="binding.managed"
                size="sm"
                type="button"
                variant="outline"
                :disabled="pending"
                @click="prepare(binding)"
              >
                <Terminal class="size-4" />
                Prepare install
              </Button>
              <Button
                v-if="binding.managed"
                size="sm"
                type="button"
                variant="ghost"
                :disabled="pending"
                @click="remove(binding)"
              >
                <Trash2 class="size-4" />
              </Button>
            </div>
          </div>
          <div v-if="binding.id && readyDraft(binding.id)" class="rounded-md bg-muted p-3">
            <div class="flex flex-wrap items-center justify-between gap-2">
              <p class="text-xs text-muted-foreground">Bundle ready. The command expires in 15 minutes and is shown once.</p>
              <Button size="sm" type="button" :disabled="pending" @click="issue(readyDraft(binding.id)!)">
                Generate curl command
              </Button>
            </div>
          </div>
        </div>
      </div>

      <div v-if="issuedCommand" class="space-y-2 rounded-lg border border-primary/40 p-4">
        <p class="text-sm font-medium">One-time bootstrap command</p>
        <code class="block overflow-x-auto rounded bg-muted p-3 text-xs">{{ issuedCommand }}</code>
        <Button size="sm" type="button" variant="outline" @click="copyCommand">
          <Copy class="size-4" />
          Copy
        </Button>
      </div>
    </CardContent>
  </Card>
</template>

<script setup lang="ts">
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import {
  Card, CardContent, CardDescription, CardHeader, CardTitle,
} from '@/components/ui/card'
import { Checkbox } from '@/components/ui/checkbox'
import { Input } from '@/components/ui/input'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import type {
  AuthConfiguration,
  ClientProfileDescriptor,
  JobRecord,
  ProfileServerBinding,
  ServerBootstrapDraft,
  ServerBootstrapIssueResult,
  ServerPackFile,
  ServerPackVersion,
} from '@gravit-panel/shared'
import { useMutation, useQueries, useQuery, useQueryClient } from '@tanstack/vue-query'
import {
  Copy, Pencil, Plus, Save, ShieldAlert, Terminal, Trash2, TriangleAlert,
} from '@lucide/vue'
import { computed, reactive, ref, watch } from 'vue'

const props = defineProps<{
  installationId: string
  profile: ClientProfileDescriptor
  disabled: boolean
}>()
const emit = defineEmits<{ job: [job: JobRecord] }>()
const queryClient = useQueryClient()
const editing = ref<'new' | string | null>(null)
const issuedCommand = ref('')
const jvmArgs = ref('')
const gameArgs = ref('nogui')
const packSelection = ref('none')
const form = reactive({
  name: '',
  serverAddress: '',
  serverPort: 25565,
  isDefault: false,
  authId: '',
  xms: '1G',
  xmx: '4G',
})

const getJson = async <T>(input: RequestInfo | URL, init?: RequestInit): Promise<T> => {
  const response = await fetch(input, init)
  if (!response.ok) {
    const body = (await response.json().catch(() => null)) as { message?: string } | null
    throw new Error(body?.message ?? `Request failed with status ${response.status}`)
  }
  return response.json() as Promise<T>
}
const bindingKey = computed(() => ['server-bindings', props.installationId, props.profile.name])
const { data: bindings, error: bindingError } = useQuery({
  queryKey: bindingKey,
  queryFn: () => getJson<{ items: ProfileServerBinding[] }>(
    `/api/servers/profiles/${encodeURIComponent(props.profile.name)}/bindings?installationId=${encodeURIComponent(props.installationId)}`,
  ),
})
const { data: auth } = useQuery({
  queryKey: computed(() => ['auth-configuration', props.installationId]),
  queryFn: () => getJson<AuthConfiguration>(
    `/api/auth/configuration?installationId=${encodeURIComponent(props.installationId)}`,
  ),
})
watch(auth, (value) => {
  if (!form.authId) form.authId = value?.providers.find((item) => item.isDefault)?.id ?? value?.providers[0]?.id ?? ''
}, { immediate: true })
const { data: pack } = useQuery({
  queryKey: computed(() => ['server-pack', props.installationId, props.profile.name]),
  queryFn: () => getJson<{ items: ServerPackFile[]; versions: ServerPackVersion[] }>(
    `/api/servers/profiles/${encodeURIComponent(props.profile.name)}/pack?installationId=${encodeURIComponent(props.installationId)}`,
  ),
})
const managedIds = computed(
  () => bindings.value?.items.flatMap((item) => item.id ? [item.id] : []) ?? [],
)
const draftQueries = useQueries({
  queries: computed(() => managedIds.value.map((id) => ({
    queryKey: ['server-bootstrap', props.installationId, id],
    queryFn: () => getJson<{ items: ServerBootstrapDraft[] }>(
      `/api/servers/bindings/${id}/bootstrap?installationId=${encodeURIComponent(props.installationId)}`,
    ),
    refetchInterval: 5000,
  }))),
})
const readyDraft = (bindingId: string) =>
  draftQueries.value
    .find((query) => query.data?.items.some((item) => item.bindingId === bindingId))
    ?.data?.items.find((item) => item.bindingId === bindingId && item.status === 'ready') ?? null

const jobMutation = useMutation({
  mutationFn: (request: { path: string; body: Record<string, unknown>; nestedJob?: boolean }) =>
    getJson<JobRecord | { job: JobRecord }>(request.path, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(request.body),
    }).then((result) => 'job' in result ? result.job : result),
  onSuccess: (job) => {
    editing.value = null
    emit('job', job)
  },
})
const issueMutation = useMutation({
  mutationFn: (draft: ServerBootstrapDraft) => getJson<ServerBootstrapIssueResult>(
    `/api/servers/bootstrap/${draft.id}/issue`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ installationId: props.installationId }),
    },
  ),
  onSuccess: (result) => {
    issuedCommand.value = result.command
    void queryClient.invalidateQueries({ queryKey: ['server-bootstrap'] })
  },
})
const startCreate = () => {
  editing.value = 'new'
  Object.assign(form, {
    name: '',
    serverAddress: '',
    serverPort: 25565,
    isDefault: !bindings.value?.items.length,
    authId: auth.value?.providers.find((item) => item.isDefault)?.id ?? auth.value?.providers[0]?.id ?? '',
    xms: '1G',
    xmx: '4G',
  })
  packSelection.value = pack.value?.versions[0]?.id ?? 'none'
  jvmArgs.value = ''
  gameArgs.value = 'nogui'
}
const edit = (binding: ProfileServerBinding) => {
  editing.value = binding.id
  Object.assign(form, {
    name: binding.name,
    serverAddress: binding.serverAddress,
    serverPort: binding.serverPort,
    isDefault: binding.isDefault,
    authId: binding.authId ?? '',
    xms: binding.xms ?? '1G',
    xmx: binding.xmx ?? '4G',
  })
  packSelection.value = binding.packVersionId ?? 'none'
  jvmArgs.value = binding.jvmArgs.join(' ')
  gameArgs.value = binding.gameArgs.join(' ')
}
const adopt = (binding: ProfileServerBinding) => {
  edit({
    ...binding,
    id: null,
    authId: auth.value?.providers.find((item) => item.isDefault)?.id ??
      auth.value?.providers[0]?.id ?? '',
    xms: '1G',
    xmx: '4G',
  })
  editing.value = 'new'
}
const splitArgs = (value: string) => value.trim() ? value.trim().split(/\s+/) : []
const body = () => ({
  installationId: props.installationId,
  ...form,
  packVersionId: packSelection.value === 'none' ? null : packSelection.value,
  jvmArgs: splitArgs(jvmArgs.value),
  gameArgs: splitArgs(gameArgs.value),
})
const save = () => jobMutation.mutate({
  path: editing.value === 'new'
    ? `/api/servers/profiles/${encodeURIComponent(props.profile.name)}/bindings`
    : `/api/servers/bindings/${editing.value}/update`,
  body: body(),
})
const remove = (binding: ProfileServerBinding) => {
  if (!binding.id || !window.confirm(`Remove ${binding.name}? The native JWT will not be revoked.`)) return
  jobMutation.mutate({
    path: `/api/servers/bindings/${binding.id}/remove`,
    body: { installationId: props.installationId, confirmRemove: true },
  })
}
const prepare = (binding: ProfileServerBinding) => {
  if (!binding.id || !window.confirm('I accept the Minecraft EULA and want to prepare this installation.')) return
  jobMutation.mutate({
    path: `/api/servers/bindings/${binding.id}/bootstrap/prepare`,
    body: { installationId: props.installationId, confirmEula: true },
    nestedJob: true,
  })
}
const issue = (draft: ServerBootstrapDraft) => issueMutation.mutate(draft)
const copyCommand = () => navigator.clipboard.writeText(issuedCommand.value)
const canSave = computed(
  () => Boolean(
    form.name.trim() && form.serverAddress.trim() && form.serverPort > 0 &&
    form.authId && /^[1-9][0-9]{0,5}[MG]$/i.test(form.xms) &&
    /^[1-9][0-9]{0,5}[MG]$/i.test(form.xmx),
  ),
)
const pending = computed(
  () => props.disabled || jobMutation.isPending.value || issueMutation.isPending.value,
)
const error = computed(
  () => (bindingError.value || jobMutation.error.value || issueMutation.error.value) as Error | null,
)
</script>
