<template>
  <Alert v-if="status?.updateAvailable" class="mb-6 border-sky-500/40 bg-sky-500/5">
    <CloudDownload class="size-4" />
    <AlertTitle>Panel update available</AlertTitle>
    <AlertDescription class="mt-1 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
      <div>
        <p>A newer API and web image has been published.</p>
        <p class="mt-1 font-mono text-[11px] text-muted-foreground">
          {{ shortRevision(status.currentRevision) }} → {{ shortRevision(status.latestRevision) }}
        </p>
        <p v-if="deployResult" class="mt-2 text-foreground">
          {{ deployResult.message }} The panel will restart when Coolify finishes deployment.
        </p>
        <p v-else-if="deployError" class="mt-2 text-destructive">
          {{ deployError.message }}
        </p>
        <p v-else-if="!status.deployEnabled" class="mt-2 text-amber-700 dark:text-amber-300">
          Configure the Coolify API URL, token, and application UUID to update from the panel.
        </p>
      </div>
      <Button
        class="shrink-0"
        size="sm"
        type="button"
        :disabled="!status.deployEnabled || deploying || Boolean(deployResult)"
        @click="deploy"
      >
        <LoaderCircle v-if="deploying" class="animate-spin" />
        <CloudDownload v-else />
        {{ deployResult ? 'Deployment queued' : 'Pull & restart' }}
      </Button>
    </AlertDescription>
  </Alert>
</template>

<script setup lang="ts">
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { panelFetch } from '@/lib/public-path'
import type { PanelUpdateDeployResult, PanelUpdateStatus } from '@gravit-panel/shared'
import { useMutation, useQuery } from '@tanstack/vue-query'
import { CloudDownload, LoaderCircle } from '@lucide/vue'
import { computed } from 'vue'

const request = async <T>(path: string, init?: RequestInit) => {
  const response = await panelFetch(path, init)
  const body = (await response.json().catch(() => null)) as T | { message?: string } | null
  if (!response.ok) {
    throw new Error(
      body && typeof body === 'object' && 'message' in body && body.message
        ? body.message
        : `Request failed with status ${response.status}`,
    )
  }
  return body as T
}

const { data: status } = useQuery({
  queryKey: ['panel-self-update'],
  queryFn: () => request<PanelUpdateStatus>('/api/self-update'),
  staleTime: 5 * 60_000,
  refetchInterval: 10 * 60_000,
})
const mutation = useMutation({
  mutationFn: () => request<PanelUpdateDeployResult>('/api/self-update/deploy', { method: 'POST' }),
})
const deploying = computed(() => mutation.isPending.value)
const deployResult = computed(() => mutation.data.value ?? null)
const deployError = computed(() => mutation.error.value as Error | null)
const deploy = () => mutation.mutate()
const shortRevision = (revision: string | null) => revision?.slice(0, 8) ?? 'unknown'
</script>
