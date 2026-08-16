<template>
  <section class="mx-auto max-w-[100rem] space-y-6 p-4 sm:p-6">
    <div>
      <h2 class="text-2xl font-semibold tracking-tight">LaunchServer Files</h2>
      <p class="mt-1 text-sm text-muted-foreground">
        Browse and edit the live LaunchServer data volume. Protected credentials and runtime files are hidden.
      </p>
    </div>
    <ServerFilesCard
      v-if="launchServerId"
      :installation-id="launchServerId"
      server-name="LaunchServer"
      :disabled="false"
      endpoint-base="/api/gravit/files"
      title="LaunchServer data files"
      root-label="LaunchServer"
    />
  </section>
</template>

<script setup lang="ts">
import ServerFilesCard from '@/components/clients/ServerFilesCard.vue'
import { useLaunchServerStore } from '@/stores/launchserver'
import { storeToRefs } from 'pinia'

const { launchServerId } = storeToRefs(useLaunchServerStore())
</script>
