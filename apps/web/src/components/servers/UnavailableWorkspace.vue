<template>
  <div class="grid min-h-64 place-items-center rounded-lg bg-muted/30 p-6 text-center">
    <div>
      <CircleOff class="mx-auto size-5 text-muted-foreground" />
      <p class="mt-3 text-sm font-medium">{{ title }}</p>
      <p class="mt-1 text-xs text-muted-foreground">Adopt this server to enable managed operations.</p>
    </div>
  </div>
</template>

<script setup lang="ts">
import { CircleOff } from '@lucide/vue'

defineProps<{ title: string }>()
</script>
