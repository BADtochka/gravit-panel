<template>
  <section class="space-y-4 rounded-lg border bg-card p-4 md:p-6">
    <div class="flex flex-wrap items-start justify-between gap-3">
      <div>
        <p class="text-xs font-medium uppercase tracking-wide text-muted-foreground">Profile details</p>
        <h3 class="mt-1 text-lg font-semibold">Configure Launcher profile</h3>
        <p class="mt-1 text-sm text-muted-foreground">
          LauncherDockered, RemoteControl, MirrorHelper, and LauncherPrestarter are prepared in one
          background job.
        </p>
      </div>
      <span class="rounded-md border px-2 py-1 text-xs text-muted-foreground">Background job</span>
    </div>

    <p
      v-if="!hostReady && form.mode !== 'attach'"
      class="rounded-md border border-amber-200 bg-amber-50 p-3 text-sm text-amber-950 dark:border-amber-900 dark:bg-amber-950/40 dark:text-amber-100"
    >
      Pass Docker preflight on the selected port before starting or configuring an installation.
      Attaching an already running server does not require a free port.
    </p>

    <form class="grid gap-5 lg:grid-cols-2" @submit.prevent="requestInstallation">
      <div class="space-y-4">
        <fieldset>
          <legend class="text-sm font-medium">Source</legend>
          <RadioGroup v-model="form.mode" class="mt-2 grid gap-2 sm:grid-cols-3">
            <label
              for="source-clone"
              class="flex cursor-pointer items-start gap-2 rounded-md border p-3 text-sm"
              :class="{ 'border-foreground bg-accent': form.mode === 'clone' }"
            >
              <RadioGroupItem id="source-clone" class="mt-0.5" value="clone" />
              <span>
                <span class="font-medium">Fresh clone</span>
                <span class="mt-1 block text-xs text-muted-foreground">Pinned upstream revision</span>
              </span>
            </label>
            <label
              for="source-import"
              class="flex cursor-pointer items-start gap-2 rounded-md border p-3 text-sm"
              :class="{ 'border-foreground bg-accent': form.mode === 'import' }"
            >
              <RadioGroupItem id="source-import" class="mt-0.5" value="import" />
              <span>
                <span class="font-medium">Import</span>
                <span class="mt-1 block text-xs text-muted-foreground">Existing Git checkout</span>
              </span>
            </label>
            <label
              for="source-attach"
              class="flex cursor-pointer items-start gap-2 rounded-md border p-3 text-sm"
              :class="{ 'border-foreground bg-accent': form.mode === 'attach' }"
            >
              <RadioGroupItem id="source-attach" class="mt-0.5" value="attach" />
              <span>
                <span class="font-medium">Attach server</span>
                <span class="mt-1 block text-xs text-muted-foreground">Use running Compose services</span>
              </span>
            </label>
          </RadioGroup>
        </fieldset>

        <label class="block text-sm font-medium">
          Installation name
          <Input
            v-model.trim="form.installationName"
            class="mt-1"
            maxlength="64"
            pattern="[a-zA-Z0-9][a-zA-Z0-9_-]*"
            required
          />
          <span
            v-if="configuration && form.mode === 'clone'"
            class="mt-1 block break-all text-xs text-muted-foreground"
          >
            {{ configuration.installationsRoot }}/{{ form.installationName }}
          </span>
          <span v-else class="mt-1 block text-xs text-muted-foreground">
            Display name used in the panel.
          </span>
        </label>
        <label v-if="form.mode !== 'clone'" class="block text-sm font-medium">
          Existing absolute path
          <Input
            v-model.trim="form.importPath"
            class="mt-1 font-mono"
            placeholder="/srv/LauncherDockered"
            required
          />
          <span class="mt-1 block text-xs text-muted-foreground">
            The directory must contain the official LauncherDockered Git checkout and compose file.
          </span>
        </label>
      </div>

      <div class="space-y-4">
        <label class="block text-sm font-medium">
          External address
          <Input
            v-model.trim="form.address"
            class="mt-1"
            maxlength="255"
            placeholder="launcher.example.com"
            required
          />
          <span class="mt-1 block text-xs text-muted-foreground">
            Host or host:port without a scheme or path.
          </span>
        </label>
        <label class="block text-sm font-medium">
          Project name
          <Input
            v-model.trim="form.projectName"
            class="mt-1"
            maxlength="64"
            pattern="[a-zA-Z0-9][a-zA-Z0-9_-]*"
            required
          />
        </label>
        <Button
          class="w-full"
          type="submit"
          :disabled="
            isPending ||
            (form.mode !== 'attach' && !hostReady) ||
            Boolean(activeJob && !terminal)
          "
        >
          <LoaderCircle v-if="isPending || (activeJob && !terminal)" class="size-4 animate-spin" />
          <Play v-else class="size-4" />
          {{ activeJob && !terminal ? 'Installation running' : 'Start installation' }}
        </Button>
      </div>
    </form>

    <AlertDialog v-model:open="confirmationOpen">
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Confirm profile creation</AlertDialogTitle>
          <AlertDialogDescription>
            This operation prepares LauncherDockered and automatically configures a restricted
            RemoteControl token, the pinned MirrorHelper workspace, and LauncherPrestarter.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <dl class="grid gap-3 rounded-md border bg-muted/40 p-4 text-sm">
          <div class="grid grid-cols-[7rem_minmax(0,1fr)] gap-3">
            <dt class="text-muted-foreground">Mode</dt>
            <dd>
              {{
                form.mode === 'clone'
                  ? 'Fresh clone'
                  : form.mode === 'import'
                    ? 'Configure existing checkout'
                    : 'Attach running server'
              }}
            </dd>
          </div>
          <div class="grid grid-cols-[7rem_minmax(0,1fr)] gap-3">
            <dt class="text-muted-foreground">Target</dt>
            <dd class="break-all font-mono text-xs">{{ installationTarget }}</dd>
          </div>
          <div class="grid grid-cols-[7rem_minmax(0,1fr)] gap-3">
            <dt class="text-muted-foreground">Address</dt>
            <dd>{{ form.address }}</dd>
          </div>
          <div class="grid grid-cols-[7rem_minmax(0,1fr)] gap-3">
            <dt class="text-muted-foreground">Compose project</dt>
            <dd>{{ form.projectName }}</dd>
          </div>
          <div class="grid grid-cols-[7rem_minmax(0,1fr)] gap-3">
            <dt class="text-muted-foreground">Automatic</dt>
            <dd>Encryption key · RemoteControl · MirrorHelper · Prestarter</dd>
          </div>
        </dl>
        <AlertDialogFooter>
          <AlertDialogCancel>Cancel</AlertDialogCancel>
          <AlertDialogAction @click="submitInstallation">
            Confirm and create profile
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>

    <p
      v-if="configurationError || mutationError"
      class="rounded-md border border-destructive/30 bg-destructive/5 p-3 text-sm text-destructive"
    >
      {{ (configurationError || mutationError)?.message }}
    </p>

    <JobLogCard :job="activeJob" title="Profile creation" @finished="installationFinished" />
  </section>
</template>

<script setup lang="ts">
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog'
import JobLogCard from '@/components/jobs/JobLogCard.vue'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group'
import { useInstallationsStore } from '@/stores/installations'
import type {
  DockerInstallConfiguration,
  JobRecord,
  LauncherDockeredInstallRequest,
  LauncherDockeredInstallMode,
} from '@gravit-panel/shared'
import { useMutation, useQuery, useQueryClient } from '@tanstack/vue-query'
import { LoaderCircle, Play } from '@lucide/vue'
import { computed, reactive, ref, watch } from 'vue'

defineProps<{ hostReady: boolean }>()
const emit = defineEmits<{
  installed: []
  busyChange: [busy: boolean]
}>()

const queryClient = useQueryClient()
const installationsStore = useInstallationsStore()
const confirmationOpen = ref(false)
const activeJob = ref<JobRecord | null>(null)

const form = reactive({
  mode: 'clone' as LauncherDockeredInstallMode,
  installationName: 'default',
  importPath: '',
  address: 'localhost:17549',
  projectName: 'MY_PROJECT',
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
  queryKey: ['docker-install-configuration'],
  queryFn: () => getJson<DockerInstallConfiguration>('/api/docker/install/configuration'),
})

const connectToJob = (job: JobRecord) => {
  activeJob.value = job
}
const installationFinished = async (record: JobRecord) => {
  activeJob.value = record
  if (record.status !== 'succeeded') return
  const installationId = record.result?.installationId
  if (typeof installationId === 'string') {
    installationsStore.selectedInstallationId = installationId
  }
  await queryClient.invalidateQueries({ queryKey: ['docker-installations'] })
  emit('installed')
}

const {
  error: mutationError,
  isPending,
  mutate,
} = useMutation({
  mutationFn: (input: LauncherDockeredInstallRequest) =>
    getJson<JobRecord>('/api/docker/install', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(input),
    }),
  onSuccess: connectToJob,
})

const installationTarget = computed(() =>
  form.mode === 'clone'
    ? `${configuration.value?.installationsRoot ?? ''}/${form.installationName}`
    : form.importPath,
)

const requestInstallation = () => {
  confirmationOpen.value = true
}

const submitInstallation = () => {
  const input: LauncherDockeredInstallRequest = {
    mode: form.mode,
    installationName: form.installationName,
    address: form.address,
    projectName: form.projectName,
    confirmInstallation: true,
    ...(form.mode !== 'clone' ? { importPath: form.importPath } : {}),
  }
  confirmationOpen.value = false
  mutate(input)
}

const terminal = computed(
  () =>
    activeJob.value?.status === 'succeeded' ||
    activeJob.value?.status === 'failed' ||
    activeJob.value?.status === 'cancelled',
)
const operationRunning = computed(
  () => isPending.value || Boolean(activeJob.value && !terminal.value),
)
watch(operationRunning, (busy) => emit('busyChange', busy), { immediate: true })

</script>
