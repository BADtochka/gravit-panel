<template>
  <section class="space-y-6">
    <div class="flex flex-wrap items-start justify-between gap-4">
      <div>
        <h2 class="text-2xl font-semibold tracking-tight">Set up LaunchServer</h2>
        <p class="mt-1 text-sm text-muted-foreground">
          Check this host and prepare the single LaunchServer managed by this panel.
        </p>
      </div>
      <Button
        variant="outline"
        type="button"
        :disabled="isFetching || !isValidPort"
        @click="refetch()"
      >
        <RefreshCw class="size-4" :class="{ 'animate-spin': isFetching }" aria-hidden="true" />
        Run checks
      </Button>
    </div>

    <div class="grid gap-6 xl:grid-cols-[minmax(0,1fr)_20rem]">
      <div class="space-y-4">
        <div
          v-if="preflight"
          class="flex items-start gap-3 rounded-lg border p-4"
          :class="
            preflight.ready
              ? 'border-emerald-200 bg-emerald-50 text-emerald-950 dark:border-emerald-900 dark:bg-emerald-950/40 dark:text-emerald-100'
              : 'border-amber-200 bg-amber-50 text-amber-950 dark:border-amber-900 dark:bg-amber-950/40 dark:text-amber-100'
          "
        >
          <CircleCheckBig v-if="preflight.ready" class="mt-0.5 size-5 shrink-0" aria-hidden="true" />
          <TriangleAlert v-else class="mt-0.5 size-5 shrink-0" aria-hidden="true" />
          <div>
            <p class="text-sm font-semibold">
              {{ preflight.ready ? 'Host is ready' : 'Action required' }}
            </p>
            <p class="mt-1 text-sm opacity-80">
              {{
                preflight.ready
                  ? 'Docker, Compose, and the selected host port are ready.'
                  : 'Resolve the failed checks before setting up LaunchServer.'
              }}
            </p>
          </div>
        </div>

        <p
          v-if="error"
          class="rounded-md border border-destructive/30 bg-destructive/5 p-3 text-sm text-destructive"
        >
          {{ error.message }}
        </p>

        <div v-if="isLoading" class="grid min-h-56 place-items-center rounded-lg border bg-card">
          <span class="flex items-center gap-2 text-sm text-muted-foreground">
            <RefreshCw class="size-4 animate-spin" aria-hidden="true" />
            Checking this host...
          </span>
        </div>

        <div v-else class="space-y-3">
          <article
            v-for="check in preflight?.checks"
            :key="check.id"
            class="rounded-lg border bg-card p-4"
          >
            <div class="flex items-start gap-3">
              <CircleCheckBig
                v-if="check.status === 'passed'"
                class="mt-0.5 size-5 shrink-0 text-emerald-600 dark:text-emerald-400"
                aria-hidden="true"
              />
              <CircleX
                v-else
                class="mt-0.5 size-5 shrink-0 text-red-600 dark:text-red-400"
                aria-hidden="true"
              />
              <div class="min-w-0 flex-1">
                <div class="flex flex-wrap items-center justify-between gap-2">
                  <h3 class="text-sm font-semibold">{{ check.title }}</h3>
                  <span
                    class="rounded px-2 py-0.5 text-xs font-medium"
                    :class="
                      check.status === 'passed'
                        ? 'bg-emerald-100 text-emerald-800 dark:bg-emerald-950 dark:text-emerald-300'
                        : 'bg-red-100 text-red-800 dark:bg-red-950 dark:text-red-300'
                    "
                  >
                    {{ check.status === 'passed' ? 'Passed' : 'Failed' }}
                  </span>
                </div>
                <p class="mt-1 text-sm text-muted-foreground">{{ check.message }}</p>
                <p v-if="check.details" class="mt-2 break-words font-mono text-xs text-muted-foreground">
                  {{ check.details }}
                </p>
                <div
                  v-if="check.remediation"
                  class="mt-3 rounded-md border border-amber-200 bg-amber-50 p-3 text-sm text-amber-950 dark:border-amber-900 dark:bg-amber-950/40 dark:text-amber-100"
                >
                  <span class="font-medium">Next step:</span> {{ check.remediation }}
                </div>
              </div>
            </div>
          </article>
        </div>
      </div>

      <aside class="space-y-4">
        <form class="rounded-lg border bg-card p-4" @submit.prevent="applyPort">
          <div class="flex items-center gap-2">
            <Container class="size-4" aria-hidden="true" />
            <h3 class="text-sm font-semibold">Launcher host port</h3>
          </div>
          <label for="launcher-port" class="mt-4 block text-xs font-medium text-muted-foreground">
            TCP port
          </label>
          <div class="mt-1 flex gap-2">
            <Input
              id="launcher-port"
              v-model.number="portInput"
              class="min-w-0 flex-1"
              type="number"
              min="1"
              max="65535"
              required
            />
            <Button size="sm" type="submit" :disabled="!isValidPort || isFetching">Check</Button>
          </div>
          <p v-if="!isValidPort" class="mt-2 text-xs text-destructive">
            Enter a port from 1 to 65535.
          </p>
          <p v-else class="mt-2 text-xs text-muted-foreground">
            The upstream compose file currently publishes nginx on port 17549.
          </p>
        </form>

        <div v-if="preflight" class="rounded-lg border bg-card p-4">
          <p class="text-xs font-medium uppercase tracking-wide text-muted-foreground">
            Verified source
          </p>
          <a
            class="mt-2 block break-words text-sm font-medium underline underline-offset-4"
            :href="sourceUrl"
            target="_blank"
            rel="noreferrer"
          >
            GravitLauncher/LauncherDockered
          </a>
          <p class="mt-2 font-mono text-xs text-muted-foreground">
            {{ preflight.source.revision.slice(0, 12) }} · {{ preflight.source.file }}
          </p>
          <p class="mt-3 text-xs text-muted-foreground">
            Last checked {{ formatCheckedAt(preflight.checkedAt) }}
          </p>
        </div>
      </aside>
    </div>

    <LauncherDockeredInstall
      :host-ready="Boolean(preflight?.ready && preflight.port === 17_549)"
      @installed="$emit('installed')"
      @busy-change="$emit('busyChange', $event)"
    />
  </section>
</template>

<script setup lang="ts">
import LauncherDockeredInstall from '@/components/setup/LauncherDockeredInstall.vue'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import type { DockerPreflightResponse } from '@gravit-panel/shared'
import { useQuery } from '@tanstack/vue-query'
import {
  CircleCheckBig,
  CircleX,
  Container,
  RefreshCw,
  TriangleAlert,
} from '@lucide/vue'
import { computed, ref } from 'vue'

defineEmits<{
  installed: []
  busyChange: [busy: boolean]
}>()

const portInput = ref<number | string>(17_549)
const selectedPort = ref(17_549)
const isValidPort = computed(
  () =>
    typeof portInput.value === 'number' &&
    Number.isInteger(portInput.value) &&
    portInput.value >= 1 &&
    portInput.value <= 65_535,
)

const getPreflight = async (port: number): Promise<DockerPreflightResponse> => {
  const response = await fetch(`/api/docker/preflight?port=${port}`)
  if (!response.ok) throw new Error(`Preflight failed with status ${response.status}`)
  return response.json() as Promise<DockerPreflightResponse>
}

const {
  data: preflight,
  error,
  isFetching,
  isLoading,
  refetch,
} = useQuery({
  queryKey: computed(() => ['docker-preflight', selectedPort.value]),
  queryFn: () => getPreflight(selectedPort.value),
})

const applyPort = () => {
  if (!isValidPort.value || typeof portInput.value !== 'number') return
  if (selectedPort.value === portInput.value) void refetch()
  else selectedPort.value = portInput.value
}

const sourceUrl = computed(() => {
  if (!preflight.value) return '#'
  const { repository, revision, file } = preflight.value.source
  return `${repository}/blob/${revision}/${file}`
})

const formatCheckedAt = (value: string) =>
  new Intl.DateTimeFormat(undefined, {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).format(new Date(value))
</script>
