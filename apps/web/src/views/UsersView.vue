<template>
  <section class="space-y-6">
    <div>
      <h2 class="text-2xl font-semibold tracking-tight">Users</h2>
      <p class="mt-1 text-sm text-muted-foreground">
        Manage accounts for the selected auth provider when the core supports it.
      </p>
    </div>

    <Alert v-if="pageError" variant="destructive">
      <TriangleAlert class="size-4" />
      <AlertTitle>Users operation failed</AlertTitle>
      <AlertDescription>{{ pageError.message }}</AlertDescription>
    </Alert>

    <Card>
      <CardHeader>
        <CardTitle class="text-base">Auth provider</CardTitle>
        <CardDescription>
          The Users page adapts to the selected provider core. Only FileAuthSystem supports CRUD.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <Select v-model="authId">
          <SelectTrigger class="w-full max-w-md">
            <SelectValue placeholder="Select auth provider" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem
              v-for="provider in configuration?.providers"
              :key="provider.id"
              :value="provider.id"
            >
              {{ provider.displayName }} · {{ provider.id }} · {{ provider.coreType }}
            </SelectItem>
          </SelectContent>
        </Select>
      </CardContent>
    </Card>

    <Card v-if="users && !users.managed">
      <CardHeader>
        <CardTitle class="text-base">External user directory</CardTitle>
        <CardDescription>
          {{ users.coreType }} · {{ users.authId }}
        </CardDescription>
      </CardHeader>
      <CardContent class="space-y-3">
        <Alert>
          <Users class="size-4" />
          <AlertTitle>Not managed in-panel</AlertTitle>
          <AlertDescription>{{ users.reason }}</AlertDescription>
        </Alert>
        <Button as-child variant="outline">
          <RouterLink to="/auth">Open Auth configuration</RouterLink>
        </Button>
      </CardContent>
    </Card>

    <template v-else-if="users?.managed">
      <Card>
        <CardHeader class="flex-row items-start justify-between gap-4 space-y-0">
          <div>
            <CardTitle class="text-base">FileAuthSystem users</CardTitle>
            <CardDescription>
              {{ users.users.length }} account{{ users.users.length === 1 ? '' : 's' }} in
              Database.json
            </CardDescription>
          </div>
          <Button type="button" @click="createOpen = true">
            <UserPlus />
            Create user
          </Button>
        </CardHeader>
        <CardContent class="space-y-2">
          <div
            v-if="users.users.length === 0"
            class="rounded-md border border-dashed p-6 text-sm text-muted-foreground"
          >
            No users yet. Create the first FileAuthSystem account.
          </div>
          <div
            v-for="user in users.users"
            :key="user.uuid"
            class="flex flex-wrap items-center justify-between gap-3 rounded-md border p-3"
          >
            <div>
              <p class="font-medium">{{ user.username }}</p>
              <p class="font-mono text-xs text-muted-foreground">{{ user.uuid }}</p>
            </div>
            <div class="flex gap-2">
              <Button size="sm" type="button" variant="outline" @click="openPassword(user.username)">
                Password
              </Button>
              <AlertDialog>
                <AlertDialogTrigger as-child>
                  <Button size="sm" type="button" variant="destructive">Delete</Button>
                </AlertDialogTrigger>
                <AlertDialogContent>
                  <AlertDialogHeader>
                    <AlertDialogTitle>Delete {{ user.username }}?</AlertDialogTitle>
                    <AlertDialogDescription>
                      Removes the account from Database.json and reloads FileAuthSystem.
                    </AlertDialogDescription>
                  </AlertDialogHeader>
                  <AlertDialogFooter>
                    <AlertDialogCancel>Cancel</AlertDialogCancel>
                    <AlertDialogAction @click="deleteUser(user.username)">Delete</AlertDialogAction>
                  </AlertDialogFooter>
                </AlertDialogContent>
              </AlertDialog>
            </div>
          </div>
        </CardContent>
      </Card>
    </template>

    <Dialog v-model:open="createOpen">
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Create FileAuthSystem user</DialogTitle>
          <DialogDescription>
            Runs <code>config auth.{{ authId }}.core register</code>.
          </DialogDescription>
        </DialogHeader>
        <div class="space-y-3">
          <Input v-model="createForm.username" placeholder="Username" />
          <Input v-model="createForm.email" placeholder="Email" type="email" />
          <Input v-model="createForm.password" placeholder="Password" type="password" />
        </div>
        <DialogFooter>
          <Button type="button" variant="outline" @click="createOpen = false">Cancel</Button>
          <Button type="button" :disabled="operationPending" @click="createUser">Create</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>

    <Dialog v-model:open="passwordOpen">
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Set password for {{ passwordForm.username }}</DialogTitle>
          <DialogDescription>
            Runs <code>config auth.{{ authId }}.core changePassword</code>.
          </DialogDescription>
        </DialogHeader>
        <Input v-model="passwordForm.password" placeholder="New password" type="password" />
        <DialogFooter>
          <Button type="button" variant="outline" @click="passwordOpen = false">Cancel</Button>
          <Button type="button" :disabled="operationPending" @click="setPassword">Update</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>

    <JobLogCard :job="activeJob" title="Users job" @finished="jobFinished" />
  </section>
</template>

<script setup lang="ts">
import JobLogCard from '@/components/jobs/JobLogCard.vue'
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
import { Button } from '@/components/ui/button'
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { useInstallationJob } from '@/composables/useInstallationJob'
import { useInstallationsStore } from '@/stores/installations'
import type { AuthConfiguration, AuthUsersResponse, JobRecord } from '@gravit-panel/shared'
import { useMutation, useQuery, useQueryClient } from '@tanstack/vue-query'
import { TriangleAlert, UserPlus, Users } from '@lucide/vue'
import { storeToRefs } from 'pinia'
import { computed, reactive, ref, watch } from 'vue'
import { RouterLink } from 'vue-router'

const queryClient = useQueryClient()
const { selectedInstallationId: installationId } = storeToRefs(useInstallationsStore())
const authId = ref('')
const createOpen = ref(false)
const passwordOpen = ref(false)
const createForm = reactive({ username: '', email: '', password: '' })
const passwordForm = reactive({ username: '', password: '' })

const {
  activeJob,
  activeJobError,
  attachJob,
  finishJob,
} = useInstallationJob(
  () => installationId.value,
  ['gravit.auth.user.create', 'gravit.auth.user.password', 'gravit.auth.user.delete'],
)

const getJson = async <T>(input: RequestInfo | URL, init?: RequestInit): Promise<T> => {
  const response = await fetch(input, init)
  if (!response.ok) {
    const body = (await response.json().catch(() => null)) as { message?: string } | null
    throw new Error(body?.message ?? `Request failed with status ${response.status}`)
  }
  return response.json() as Promise<T>
}

const { data: configuration, error: configurationError } = useQuery({
  queryKey: computed(() => ['auth-configuration', installationId.value]),
  queryFn: () =>
    getJson<AuthConfiguration>(
      `/api/auth/configuration?installationId=${encodeURIComponent(installationId.value)}`,
    ),
  enabled: computed(() => Boolean(installationId.value)),
  retry: false,
})

watch(
  () => configuration.value?.providers,
  (providers) => {
    if (!providers?.some((provider) => provider.id === authId.value)) {
      authId.value = providers?.find((provider) => provider.isDefault)?.id ?? providers?.[0]?.id ?? ''
    }
  },
  { immediate: true },
)

const {
  data: users,
  error: usersError,
  refetch: refetchUsers,
} = useQuery({
  queryKey: computed(() => ['auth-users', installationId.value, authId.value]),
  queryFn: () =>
    getJson<AuthUsersResponse>(
      `/api/auth/users?installationId=${encodeURIComponent(installationId.value)}&authId=${encodeURIComponent(authId.value)}`,
    ),
  enabled: computed(() => Boolean(installationId.value && authId.value)),
  retry: false,
})

const {
  mutate: mutateCreate,
  error: createError,
  isPending: createPending,
} = useMutation({
  mutationFn: () =>
    getJson<JobRecord>('/api/auth/users', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        installationId: installationId.value,
        authId: authId.value,
        ...createForm,
      }),
    }),
  onSuccess: (job) => {
    createOpen.value = false
    createForm.username = ''
    createForm.email = ''
    createForm.password = ''
    attachJob(job)
  },
})

const {
  mutate: mutatePassword,
  error: passwordError,
  isPending: passwordPending,
} = useMutation({
  mutationFn: () =>
    getJson<JobRecord>('/api/auth/users/password', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        installationId: installationId.value,
        authId: authId.value,
        username: passwordForm.username,
        password: passwordForm.password,
      }),
    }),
  onSuccess: (job) => {
    passwordOpen.value = false
    passwordForm.password = ''
    attachJob(job)
  },
})

const {
  mutate: mutateDelete,
  error: deleteError,
  isPending: deletePending,
} = useMutation({
  mutationFn: (username: string) =>
    getJson<JobRecord>('/api/auth/users/delete', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        installationId: installationId.value,
        authId: authId.value,
        username,
        confirmDelete: true,
      }),
    }),
  onSuccess: attachJob,
})

const operationPending = computed(
  () =>
    createPending.value ||
    passwordPending.value ||
    deletePending.value ||
    activeJob.value?.status === 'queued' ||
    activeJob.value?.status === 'running',
)
const pageError = computed(
  () =>
    (configurationError.value ||
      usersError.value ||
      createError.value ||
      passwordError.value ||
      deleteError.value ||
      activeJobError.value) as Error | null,
)

const createUser = () => mutateCreate()
const openPassword = (username: string) => {
  passwordForm.username = username
  passwordForm.password = ''
  passwordOpen.value = true
}
const setPassword = () => mutatePassword()
const deleteUser = (username: string) => mutateDelete(username)
const jobFinished = async (job: JobRecord) => {
  await finishJob(job)
  await queryClient.invalidateQueries({
    queryKey: ['auth-users', installationId.value, authId.value],
  })
  await refetchUsers()
}
</script>
