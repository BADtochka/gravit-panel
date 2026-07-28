<template>
  <section class="space-y-6">
    <div class="flex flex-wrap items-start justify-between gap-3">
      <div>
        <h2 class="text-2xl font-semibold tracking-tight">Status</h2>
        <p class="mt-1 text-sm text-muted-foreground">
          Inspect LaunchServer through RemoteControl with a local control-file fallback.
        </p>
      </div>
      <span
        class="rounded-md border px-2 py-1 text-xs"
        :class="
          health?.status === 'ok'
            ? 'text-emerald-700 dark:text-emerald-400'
            : 'text-muted-foreground'
        "
      >
        API {{ health?.status ?? 'checking' }}
      </span>
    </div>

    <div v-if="launchServer" class="grid gap-6 lg:grid-cols-[20rem_minmax(0,1fr)]">
      <aside class="space-y-4">
        <div class="rounded-lg border bg-card p-4">
          <p class="text-sm font-medium">LaunchServer</p>
          <p class="mt-1 text-xs text-muted-foreground">{{ launchServer.projectName }}</p>
          <template v-if="launchServer">
            <p class="mt-3 break-all font-mono text-xs text-muted-foreground">
              {{ launchServer.path }}
            </p>
            <p class="mt-2 text-xs text-muted-foreground">{{ launchServer.address }}</p>
            <p class="mt-1 font-mono text-xs text-muted-foreground">
              {{ launchServer.sourceRevision.slice(0, 12) }}
            </p>
          </template>
        </div>

        <div class="grid gap-2">
          <Button
            type="button"
            :disabled="isPending || !commandsEnabled"
            @click="runCommand('serverStatus')"
          >
            <Activity class="size-4" />
            Server status
          </Button>
          <Button
            variant="outline"
            type="button"
            :disabled="isPending || !commandsEnabled"
            @click="runCommand('securitycheck')"
          >
            <ShieldCheck class="size-4" />
            Security check
          </Button>
        </div>

        <div class="rounded-lg border border-destructive/30 p-4">
          <p class="text-sm font-medium text-destructive">Danger zone</p>
          <p class="mt-1 text-xs text-muted-foreground">
            The panel manages a single LaunchServer. Delete it only to rebuild from scratch.
          </p>
          <LaunchServerRemovalButton class="mt-3" />
        </div>
      </aside>

      <div class="min-w-0 overflow-hidden rounded-lg border bg-card">
        <div class="flex min-h-12 items-center justify-between gap-3 border-b px-4 py-2">
          <div>
            <p class="text-sm font-medium">LaunchServer output</p>
            <p v-if="result" class="text-xs text-muted-foreground">
              {{ result.command }} · {{ result.transport }} · {{ formatTime(result.finishedAt) }}
            </p>
          </div>
          <LoaderCircle v-if="isPending" class="size-4 animate-spin text-muted-foreground" />
        </div>

        <div class="min-h-80 max-h-[38rem] overflow-auto p-4 font-mono text-xs">
          <p v-if="isPending" class="text-muted-foreground">
            Waiting for the control socket and command output...
          </p>
          <p v-else-if="error" class="text-destructive">{{ error.message }}</p>
          <p v-else-if="!result" class="text-muted-foreground">
            Run a status or security command to inspect LaunchServer.
          </p>
          <div v-else-if="result.lines.length" class="space-y-1">
            <p v-for="(line, index) in result.lines" :key="`${index}-${line}`" class="break-words">
              {{ line }}
            </p>
          </div>
          <p v-else class="text-muted-foreground">The command completed without log output.</p>
          <p
            v-if="result?.fallbackReason"
            class="mt-4 rounded-md border border-amber-200 bg-amber-50 p-3 font-sans text-sm text-amber-950 dark:border-amber-900 dark:bg-amber-950/40 dark:text-amber-100"
          >
            RemoteControl failed, so this command used control-file:
            {{ result.fallbackReason }}
          </p>
        </div>

        <div v-if="result" class="border-t px-4 py-3 text-xs text-muted-foreground">
          Verified against
          <a
            class="font-medium underline underline-offset-4"
            :href="sourceUrl"
            target="_blank"
            rel="noreferrer"
          >
            Launcher@{{ result.source.revision.slice(0, 12) }}
          </a>
        </div>
      </div>
    </div>

  </section>
</template>

<script setup lang="ts">
import LaunchServerRemovalButton from '@/components/layout/LaunchServerRemovalButton.vue'
import { Button } from '@/components/ui/button'
import { useLaunchServerStore } from '@/stores/launchserver'
import type {
  ApiHealth,
  LaunchServerCommandResult,
  LaunchServerInspectionCommand,
} from '@gravit-panel/shared'
import { useMutation, useQuery } from '@tanstack/vue-query'
import { Activity, LoaderCircle, ShieldCheck } from '@lucide/vue'
import { storeToRefs } from 'pinia'
import { computed, ref, watch } from 'vue'

const { launchServer, launchServerId } = storeToRefs(
  useLaunchServerStore(),
)
const result = ref<LaunchServerCommandResult | null>(null)

const getJson = async <T>(input: RequestInfo | URL, init?: RequestInit): Promise<T> => {
  const response = await fetch(input, init)
  if (!response.ok) {
    const body = (await response.json().catch(() => null)) as { message?: string } | null
    throw new Error(body?.message ?? `Request failed with status ${response.status}`)
  }
  return response.json() as Promise<T>
}

const { data: health } = useQuery({
  queryKey: ['health'],
  queryFn: () => getJson<ApiHealth>('/api/health'),
})
watch(launchServerId, () => {
  result.value = null
})

const commandsEnabled = computed(() => Boolean(launchServerId.value))

const {
  error,
  isPending,
  mutate,
} = useMutation({
  mutationFn: (command: LaunchServerInspectionCommand) =>
    getJson<LaunchServerCommandResult>(
      command === 'serverStatus' ? '/api/gravit/status' : '/api/gravit/securitycheck',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ installationId: launchServerId.value }),
      },
    ),
  onSuccess: (value) => {
    result.value = value
  },
})

const runCommand = (command: LaunchServerInspectionCommand) => {
  result.value = null
  mutate(command)
}

const sourceUrl = computed(() => {
  if (!result.value) return '#'
  const { repository, revision, file } = result.value.source
  return `${repository}/blob/${revision}/${file}`
})

const formatTime = (value: string) =>
  new Intl.DateTimeFormat(undefined, {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).format(new Date(value))
</script>
