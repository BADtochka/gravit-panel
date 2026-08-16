<template>
  <div class="overflow-hidden rounded-xl border bg-card shadow-sm">
    <header class="flex flex-wrap items-center justify-between gap-4 border-b px-4 py-4 sm:px-6">
      <div class="flex items-center gap-3">
        <div class="grid size-9 place-items-center rounded-lg bg-primary/10 text-primary">
          <Server class="size-5" />
        </div>
        <div>
          <h2 class="text-lg font-semibold tracking-tight">Servers</h2>
          <p class="text-xs text-muted-foreground">
            {{ profile.name }} · {{ bindings?.items.length ?? 0 }} attached
          </p>
        </div>
      </div>
      <Button type="button" @click="startCreate">
        <Plus class="size-4" />
        Add server
      </Button>
    </header>

    <Alert v-if="error" variant="destructive" class="m-4 sm:mx-6">
      <TriangleAlert class="size-4" />
      <AlertTitle>Server operation failed</AlertTitle>
      <AlertDescription>{{ error.message }}</AlertDescription>
    </Alert>

    <div v-if="bindings?.items.length" class="min-h-[38rem]">
      <main v-if="selectedBinding" class="min-w-0">
        <div class="flex flex-wrap items-start justify-between gap-4 border-b px-4 py-5 sm:px-6">
          <div class="min-w-0">
            <div class="flex flex-wrap items-center gap-2">
              <h3 class="truncate text-lg font-semibold">{{ selectedBinding.name }}</h3>
              <Badge v-if="selectedBinding.isDefault" variant="secondary">Default</Badge>
              <Badge :variant="selectedBinding.managed ? 'outline' : 'destructive'">
                {{ selectedBinding.managed ? selectedBinding.deploymentState : 'Legacy' }}
              </Badge>
            </div>
            <p class="mt-1 truncate font-mono text-xs text-muted-foreground">
              {{ selectedBinding.serverAddress }}:{{ selectedBinding.serverPort }}
            </p>
          </div>
          <div class="flex items-center gap-1">
            <Button
              v-if="!selectedBinding.managed"
              size="sm"
              type="button"
              variant="outline"
              @click="adopt(selectedBinding)"
            >
              <Plus class="size-4" />
              Adopt
            </Button>
            <Button
              v-if="selectedBinding.managed"
              size="sm"
              type="button"
              variant="outline"
              @click="edit(selectedBinding)"
            >
              <Pencil class="size-4" />
              Edit
            </Button>
            <AlertDialog v-if="selectedBinding.managed">
              <AlertDialogTrigger as-child>
                <Button
                  size="icon"
                  type="button"
                  variant="ghost"
                  :disabled="pending"
                  :aria-label="`Remove ${selectedBinding.name}`"
                >
                  <Trash2 class="size-4" />
                </Button>
              </AlertDialogTrigger>
              <AlertDialogContent>
                <AlertDialogHeader>
                  <AlertDialogTitle>Remove {{ selectedBinding.name }}?</AlertDialogTitle>
                  <AlertDialogDescription>
                    The server disappears from the launcher profile. Its native JWT cannot be
                    revoked separately.
                  </AlertDialogDescription>
                </AlertDialogHeader>
                <AlertDialogFooter>
                  <AlertDialogCancel>Cancel</AlertDialogCancel>
                  <AlertDialogAction @click="remove(selectedBinding)">Remove server</AlertDialogAction>
                </AlertDialogFooter>
              </AlertDialogContent>
            </AlertDialog>
          </div>
        </div>

        <Tabs v-model="activeTab" class="gap-0">
          <div class="p-4 sm:p-6">
            <TabsContent value="overview" class="m-0 space-y-5">
              <Alert v-if="!selectedBinding.managed">
                <TriangleAlert class="size-4" />
                <AlertTitle>Legacy server binding</AlertTitle>
                <AlertDescription>
                  Adopt this server to manage installation, runtime controls, and live files.
                </AlertDescription>
              </Alert>

              <div class="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
                <div class="rounded-lg bg-muted/40 p-4">
                  <div class="flex items-center gap-2 text-xs font-medium text-muted-foreground">
                    <Network class="size-4" /> Endpoint
                  </div>
                  <p class="mt-3 break-all font-mono text-sm">
                    {{ selectedBinding.serverAddress }}:{{ selectedBinding.serverPort }}
                  </p>
                </div>
                <div class="rounded-lg bg-muted/40 p-4">
                  <div class="flex items-center gap-2 text-xs font-medium text-muted-foreground">
                    <MemoryStick class="size-4" /> Memory
                  </div>
                  <p class="mt-3 text-sm font-medium">
                    {{ selectedBinding.xms ?? 'Not set' }} → {{ selectedBinding.xmx ?? 'Not set' }}
                  </p>
                </div>
                <div class="rounded-lg bg-muted/40 p-4">
                  <div class="flex items-center gap-2 text-xs font-medium text-muted-foreground">
                    <KeyRound class="size-4" /> Auth provider
                  </div>
                  <p class="mt-3 truncate text-sm font-medium">{{ authProviderName }}</p>
                </div>
                <div class="rounded-lg bg-muted/40 p-4">
                  <div class="flex items-center gap-2 text-xs font-medium text-muted-foreground">
                    <Rocket class="size-4" /> Installation
                  </div>
                  <p class="mt-3 text-sm font-medium">
                    {{ selectedBinding.managed ? selectedBinding.deploymentState : 'Not managed' }}
                  </p>
                    <Button class="mt-3 px-0" size="sm" variant="link" @click="selectSection('deployment')">
                    Open installation <ArrowRight class="size-3.5" />
                  </Button>
                </div>
              </div>
            </TabsContent>

            <TabsContent
              value="console"
              force-mount
              class="m-0 data-[state=inactive]:hidden"
            >
              <ServerRuntimeConsole
                v-if="selectedBinding.managed && selectedBinding.id"
                :key="selectedBinding.id"
                :active="activeTab === 'console'"
                :binding-id="selectedBinding.id"
                :disabled="pending"
                :installation-id="installationId"
                @job="emit('job', $event)"
              />
              <UnavailableWorkspace v-else title="Console unavailable" />
            </TabsContent>

            <TabsContent value="files" class="m-0">
                <ServerFilesCard
                v-if="activeTab === 'files' && selectedBinding.managed && selectedBinding.id"
                :key="`files-${selectedBinding.id}`"
                :binding-id="selectedBinding.id"
                :disabled="pending"
                :installation-id="installationId"
                :server-name="selectedBinding.name"
              />
              <UnavailableWorkspace v-else title="Files & Mods unavailable" />
            </TabsContent>

            <TabsContent value="deployment" class="m-0 space-y-4">
              <Alert variant="destructive">
                <ShieldAlert class="size-4" />
                <AlertTitle>Native LaunchServer token cannot be revoked separately</AlertTitle>
                <AlertDescription>
                  It is profile-scoped, has no expiry, and is written by the native token command
                  to LaunchServer logs. Rotate LaunchServer keys if it is exposed.
                </AlertDescription>
              </Alert>

              <div v-if="selectedBinding.managed" class="rounded-lg bg-muted/35 p-4">
                <div class="flex flex-wrap items-start justify-between gap-3">
                  <div>
                    <p class="text-sm font-medium">ServerWrapper deployment</p>
                    <p class="mt-1 text-xs text-muted-foreground">
                      Prepare an installation bundle for {{ selectedBinding.name }}.
                    </p>
                  </div>
                  <div class="flex flex-wrap gap-2">
                    <Button
                      v-if="activeDraft?.status === 'ready'"
                      size="sm"
                      type="button"
                      :disabled="pending"
                      @click="issue(activeDraft)"
                    >
                      Generate curl command
                    </Button>
                    <Button
                      v-if="showPrepareInstall"
                      size="sm"
                      type="button"
                      :disabled="pending"
                      @click="requestPrepare(selectedBinding)"
                    >
                      <Terminal class="size-4" />
                      {{ selectedBinding.updaterInstalledAt ? 'Prepare server update' : 'Prepare install' }}
                    </Button>
                  </div>
                </div>

                <div v-if="activeDraft" class="mt-4 flex flex-wrap items-center justify-between gap-3 border-t pt-4">
                  <div>
                    <div class="flex flex-wrap items-center gap-2">
                      <Badge variant="outline">{{ activeDraft.status }}</Badge>
                      <span class="break-all font-mono text-[11px] text-muted-foreground">{{ activeDraft.id }}</span>
                    </div>
                    <p class="mt-2 text-xs text-muted-foreground">
                      <template v-if="activeDraft.status === 'ready'">Bundle ready for command generation.</template>
                      <template v-else>Command remains valid until install success, failure, revoke, or a binding change.</template>
                    </p>
                  </div>
                  <div class="flex gap-2">
                    <AlertDialog>
                      <AlertDialogTrigger as-child>
                        <Button size="sm" type="button" variant="outline" :disabled="pending">Revoke</Button>
                      </AlertDialogTrigger>
                      <AlertDialogContent>
                        <AlertDialogHeader>
                          <AlertDialogTitle>Revoke this bootstrap command?</AlertDialogTitle>
                          <AlertDialogDescription>
                            Existing curl commands for this prepared bundle will stop working.
                          </AlertDialogDescription>
                        </AlertDialogHeader>
                        <AlertDialogFooter>
                          <AlertDialogCancel>Cancel</AlertDialogCancel>
                          <AlertDialogAction @click="revoke(activeDraft)">Revoke command</AlertDialogAction>
                        </AlertDialogFooter>
                      </AlertDialogContent>
                    </AlertDialog>
                  </div>
                </div>
              </div>

              <div v-if="visibleIssuedCommand" class="rounded-lg border border-primary/40 bg-primary/5 p-4">
                <div class="flex flex-wrap items-start justify-between gap-3">
                  <div>
                    <p class="text-sm font-medium">One-time bootstrap command</p>
                    <p class="mt-1 text-xs text-muted-foreground">
                      Generated for {{ selectedBinding.name }} and draft {{ visibleIssuedCommand.draftId }}.
                    </p>
                  </div>
                  <Button size="sm" type="button" variant="outline" @click="copyCommand">
                    <Check v-if="copied" class="size-4" />
                    <Copy v-else class="size-4" />
                    {{ copied ? 'Copied' : 'Copy command' }}
                  </Button>
                </div>
                <code class="mt-3 block overflow-x-auto rounded-md bg-zinc-950 p-3 text-xs text-zinc-100">
                  {{ visibleIssuedCommand.command }}
                </code>
                <p v-if="visibleIssuedCommand.expiresAt" class="mt-2 text-xs text-muted-foreground">
                  Expires {{ new Date(visibleIssuedCommand.expiresAt).toLocaleString() }}
                </p>
              </div>

              <UnavailableWorkspace v-if="!selectedBinding.managed" title="Deployment unavailable" />
            </TabsContent>
          </div>
        </Tabs>
      </main>
    </div>

    <div v-else class="grid min-h-80 place-items-center p-8 text-center">
      <div>
        <div class="mx-auto grid size-11 place-items-center rounded-full bg-muted">
          <Server class="size-5 text-muted-foreground" />
        </div>
        <p class="mt-4 text-sm font-medium">No servers attached</p>
        <p class="mt-1 text-xs text-muted-foreground">Bind the first game server to this profile.</p>
        <Button class="mt-4" size="sm" @click="startCreate"><Plus class="size-4" /> Add server</Button>
      </div>
    </div>

    <Dialog v-model:open="formOpen">
      <DialogContent class="max-h-[90vh] overflow-y-auto sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>{{ editing === 'new' ? 'Add game server' : 'Edit game server' }}</DialogTitle>
          <DialogDescription>
            {{ editing === 'new'
              ? `Bind a managed server to ${profile.name}.`
              : `Update ${selectedBinding?.name ?? 'this server'} without changing its deployment.` }}
          </DialogDescription>
        </DialogHeader>
        <Alert v-if="formError" variant="destructive">
          <TriangleAlert class="size-4" />
          <AlertTitle>Unable to save server</AlertTitle>
          <AlertDescription>{{ formError.message }}</AlertDescription>
        </Alert>
        <div class="grid gap-4 py-2 sm:grid-cols-2">
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
          <div class="sm:col-span-2">
            <label class="text-xs font-medium" for="binding-jvm">Additional JVM arguments</label>
            <Input id="binding-jvm" v-model="jvmArgs" class="mt-1" placeholder="-XX:+UseG1GC" />
          </div>
          <div class="sm:col-span-2">
            <label class="text-xs font-medium" for="binding-game">Game arguments</label>
            <Input id="binding-game" v-model="gameArgs" class="mt-1" placeholder="nogui" />
          </div>
          <label class="flex items-center gap-2 text-sm sm:col-span-2">
            <Checkbox :checked="form.isDefault" @update:checked="form.isDefault = Boolean($event)" />
            Default server
          </label>
        </div>
        <DialogFooter>
          <Button type="button" variant="outline" @click="formOpen = false">Cancel</Button>
          <Button :disabled="!canSave || pending" type="button" @click="save">
            <Save class="size-4" />
            {{ editing === 'new' ? 'Bind server' : 'Save changes' }}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>

    <AlertDialog v-model:open="eulaOpen">
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Accept the Minecraft EULA?</AlertDialogTitle>
          <AlertDialogDescription>
            This confirmation is stored for this server and is not requested again for future
            install or live-agent update commands.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>Cancel</AlertDialogCancel>
          <AlertDialogAction :disabled="pending" @click="acceptEulaAndPrepare">
            Accept and prepare
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  </div>
</template>

<script setup lang="ts">
import ServerFilesCard from '@/components/clients/ServerFilesCard.vue'
import ServerRuntimeConsole from '@/components/servers/ServerRuntimeConsole.vue'
import UnavailableWorkspace from '@/components/servers/UnavailableWorkspace.vue'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
  AlertDialogTrigger,
} from '@/components/ui/alert-dialog'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Tabs, TabsContent } from '@/components/ui/tabs'
import type {
  AuthConfiguration, ClientProfileDescriptor, JobRecord, ProfileServerBinding,
  ServerBootstrapDraft, ServerBootstrapIssueResult,
} from '@gravit-panel/shared'
import { useMutation, useQuery, useQueryClient } from '@tanstack/vue-query'
import {
  ArrowRight, Check, Copy, KeyRound, MemoryStick, Network, Pencil, Plus,
  Rocket, Save, Server, ShieldAlert,
  Terminal, Trash2, TriangleAlert,
} from '@lucide/vue'
import { computed, onBeforeUnmount, reactive, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { serverBindingKey, useServersStore } from '@/stores/servers'
import { storeToRefs } from 'pinia'

const props = defineProps<{
  installationId: string
  profile: ClientProfileDescriptor
  disabled: boolean
  finishedJob?: JobRecord | null
}>()
const emit = defineEmits<{ job: [job: JobRecord] }>()
const queryClient = useQueryClient()
const route = useRoute()
const router = useRouter()
const editing = ref<'new' | string | null>(null)
const formOpen = ref(false)
const serversStore = useServersStore()
const { selectedBindingKey, dialogAction } = storeToRefs(serversStore)
const activeTab = ref('overview')
const serverSections = ['overview', 'console', 'files', 'deployment'] as const
const selectSection = (section: string) => {
  void router.push(`/panel/server/${section}`)
}
const issuedCommand = ref<{
  bindingId: string
  draftId: string
  command: string
  expiresAt: string | null
} | null>(null)
const copied = ref(false)
const copyError = ref<Error | null>(null)
const eulaOpen = ref(false)
const pendingPrepareBinding = ref<ProfileServerBinding | null>(null)
const jvmArgs = ref('')
const gameArgs = ref('nogui')
let copiedTimer: ReturnType<typeof setTimeout> | null = null
onBeforeUnmount(() => {
  if (copiedTimer) clearTimeout(copiedTimer)
})
const form = reactive({
  name: '', serverAddress: '', serverPort: 25565, isDefault: false,
  authId: '', xms: '1G', xmx: '4G',
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
const selectedBinding = computed(
  () => bindings.value?.items.find((binding) => serverBindingKey(binding) === selectedBindingKey.value) ?? null,
)
watch(() => bindings.value?.items, (items) => {
  if (items) serversStore.setBindings(items)
}, { immediate: true })
watch(() => route.meta.serverSection, (section) => {
  if (typeof section === 'string' && serverSections.includes(section as typeof serverSections[number])) activeTab.value = section
}, { immediate: true })
watch(
  () => [selectedBindingKey.value, props.profile.name, props.installationId],
  () => {
    if (!serverSections.includes(route.meta.serverSection as typeof serverSections[number])) activeTab.value = 'overview'
    issuedCommand.value = null
    copied.value = false
    copyError.value = null
  },
)
const selectedManagedId = computed(() => selectedBinding.value?.managed ? selectedBinding.value.id : null)
const { data: selectedDrafts } = useQuery({
  queryKey: computed(() => ['server-bootstrap', props.installationId, selectedManagedId.value]),
  queryFn: () => getJson<{ items: ServerBootstrapDraft[] }>(
    `/api/servers/bindings/${selectedManagedId.value}/bootstrap?installationId=${encodeURIComponent(props.installationId)}`,
  ),
  enabled: computed(() => Boolean(selectedManagedId.value)),
})
const activeDraft = computed(
  () => selectedDrafts.value?.items.find(
    (item) => item.bindingId === selectedManagedId.value && ['ready', 'issued', 'claimed'].includes(item.status),
  ) ?? null,
)
const visibleIssuedCommand = computed(() => {
  const issued = issuedCommand.value
  return issued && issued.bindingId === selectedManagedId.value && issued.draftId === activeDraft.value?.id
    ? issued
    : null
})
const authProviderName = computed(() => {
  const id = selectedBinding.value?.authId
  if (!id) return 'Not configured'
  const provider = auth.value?.providers.find((item) => item.id === id)
  return provider ? `${provider.displayName} (${provider.id})` : id
})
const showPrepareInstall = computed(() => Boolean(
  !activeDraft.value && selectedBinding.value?.managed,
))
const jobMutation = useMutation({
  mutationFn: (request: { path: string; body: Record<string, unknown>; nestedJob?: boolean }) =>
    getJson<JobRecord | { job: JobRecord }>(request.path, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(request.body),
    }).then((result) => 'job' in result ? result.job : result),
  onSuccess: (job) => {
    editing.value = null
    formOpen.value = false
    emit('job', job)
  },
})
const issueMutation = useMutation({
  mutationFn: (draft: ServerBootstrapDraft) => getJson<ServerBootstrapIssueResult>(
    `/api/servers/bootstrap/${draft.id}/issue`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ installationId: props.installationId }),
    },
  ),
  onSuccess: (result) => {
    issuedCommand.value = {
      bindingId: result.draft.bindingId, draftId: result.draft.id,
      command: result.command, expiresAt: result.expiresAt,
    }
    void router.push('/panel/server/deployment')
    void queryClient.invalidateQueries({ queryKey: ['server-bootstrap'] })
  },
})
const revokeMutation = useMutation({
  mutationFn: (draft: ServerBootstrapDraft) => getJson(`/api/servers/bootstrap/${draft.id}/revoke`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ installationId: props.installationId, confirmRevoke: true }),
  }),
  onSuccess: () => {
    issuedCommand.value = null
    void queryClient.invalidateQueries({ queryKey: ['server-bootstrap'] })
  },
})
const eulaMutation = useMutation({
  mutationFn: (binding: ProfileServerBinding) => getJson(`/api/servers/bindings/${binding.id}/eula`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ installationId: props.installationId, accepted: true }),
  }),
  onSuccess: async (_, binding) => {
    eulaOpen.value = false
    pendingPrepareBinding.value = null
    await queryClient.invalidateQueries({ queryKey: bindingKey.value })
    prepare({ ...binding, eulaAcceptedAt: new Date().toISOString() })
  },
})
const startCreate = () => {
  jobMutation.reset()
  issuedCommand.value = null
  editing.value = 'new'
  Object.assign(form, {
    name: '', serverAddress: '', serverPort: 25565, isDefault: !bindings.value?.items.length,
    authId: auth.value?.providers.find((item) => item.isDefault)?.id ?? auth.value?.providers[0]?.id ?? '',
    xms: '1G', xmx: '4G',
  })
  jvmArgs.value = ''
  gameArgs.value = 'nogui'
  formOpen.value = true
}
const edit = (binding: ProfileServerBinding) => {
  jobMutation.reset()
  issuedCommand.value = null
  selectedBindingKey.value = serverBindingKey(binding)
  editing.value = binding.id
  Object.assign(form, {
    name: binding.name, serverAddress: binding.serverAddress, serverPort: binding.serverPort,
    isDefault: binding.isDefault, authId: binding.authId ?? '',
    xms: binding.xms ?? '1G', xmx: binding.xmx ?? '4G',
  })
  jvmArgs.value = binding.jvmArgs.join(' ')
  gameArgs.value = binding.gameArgs.join(' ')
  formOpen.value = true
}
watch(
  [dialogAction, () => bindings.value?.items],
  ([action, items]) => {
    if (action === 'create') {
      startCreate()
      serversStore.consumeDialogAction()
      return
    }
    if (action === 'edit' && items) {
      const binding = items.find((item) => serverBindingKey(item) === selectedBindingKey.value)
      if (binding?.managed) edit(binding)
      serversStore.consumeDialogAction()
    }
  },
  { immediate: true },
)
const adopt = (binding: ProfileServerBinding) => {
  edit({
    ...binding, id: null,
    authId: auth.value?.providers.find((item) => item.isDefault)?.id ?? auth.value?.providers[0]?.id ?? '',
    xms: '1G', xmx: '4G',
  })
  editing.value = 'new'
}
const splitArgs = (value: string) => value.trim() ? value.trim().split(/\s+/) : []
const body = () => ({
  installationId: props.installationId, ...form, packVersionId: null,
  jvmArgs: splitArgs(jvmArgs.value), gameArgs: splitArgs(gameArgs.value),
})
const save = () => jobMutation.mutate({
  path: editing.value === 'new'
    ? `/api/servers/profiles/${encodeURIComponent(props.profile.name)}/bindings`
    : `/api/servers/bindings/${editing.value}/update`,
  body: body(),
})
const remove = (binding: ProfileServerBinding) => {
  if (!binding.id) return
  issuedCommand.value = null
  jobMutation.mutate({
    path: `/api/servers/bindings/${binding.id}/remove`,
    body: { installationId: props.installationId, confirmRemove: true },
  })
}
const prepare = (binding: ProfileServerBinding) => {
  if (!binding.id) return
  issuedCommand.value = null
  void router.push('/panel/server/deployment')
  jobMutation.mutate({
    path: `/api/servers/bindings/${binding.id}/bootstrap/prepare`,
    body: { installationId: props.installationId }, nestedJob: true,
  })
}
const requestPrepare = (binding: ProfileServerBinding) => {
  issuedCommand.value = null
  void router.push('/panel/server/deployment')
  if (binding.eulaAcceptedAt) {
    prepare(binding)
    return
  }
  pendingPrepareBinding.value = binding
  eulaOpen.value = true
}
const acceptEulaAndPrepare = () => {
  const binding = pendingPrepareBinding.value
  if (binding?.id) eulaMutation.mutate(binding)
}
const issue = (draft: ServerBootstrapDraft) => {
  issuedCommand.value = null
  void router.push('/panel/server/deployment')
  issueMutation.mutate(draft)
}
const revoke = (draft: ServerBootstrapDraft) => {
  issuedCommand.value = null
  revokeMutation.mutate(draft)
}
const copyCommand = async () => {
  if (!visibleIssuedCommand.value) return
  try {
    await navigator.clipboard.writeText(visibleIssuedCommand.value.command)
    copyError.value = null
    copied.value = true
    if (copiedTimer) clearTimeout(copiedTimer)
    copiedTimer = setTimeout(() => { copied.value = false }, 2000)
  } catch (cause) {
    copied.value = false
    copyError.value = cause instanceof Error ? cause : new Error('Unable to copy command to clipboard')
  }
}
const canSave = computed(() => Boolean(
  form.name.trim() && form.serverAddress.trim() && form.serverPort > 0 && form.authId &&
  /^[1-9][0-9]{0,5}[MG]$/i.test(form.xms) && /^[1-9][0-9]{0,5}[MG]$/i.test(form.xmx),
))
const pending = computed(() => props.disabled || jobMutation.isPending.value || issueMutation.isPending.value ||
  revokeMutation.isPending.value || eulaMutation.isPending.value)
const formError = computed(() => jobMutation.error.value as Error | null)
const error = computed(() => (
  bindingError.value || jobMutation.error.value || issueMutation.error.value || revokeMutation.error.value ||
  eulaMutation.error.value || copyError.value
) as Error | null)
</script>
