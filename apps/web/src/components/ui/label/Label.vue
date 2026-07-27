<script setup lang="ts">
import { cn } from '@/lib/utils'
import type { LabelProps } from 'reka-ui'
import { Label, useForwardProps } from 'reka-ui'
import type { HTMLAttributes } from 'vue'

const props = defineProps<LabelProps & { class?: HTMLAttributes['class'] }>()
const forwarded = useForwardProps(props)
</script>

<template>
  <Label
    data-slot="label"
    v-bind="forwarded"
    :class="cn(
      'flex items-center gap-2 text-sm leading-none font-medium select-none peer-disabled:cursor-not-allowed peer-disabled:opacity-50',
      props.class,
    )"
  >
    <slot />
  </Label>
</template>
