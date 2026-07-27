<template>
  <Combobox v-model="model" :disabled="disabled">
    <ComboboxAnchor as-child class="w-full">
      <ComboboxTrigger as-child>
        <Button
          :id="id"
          type="button"
          variant="outline"
          role="combobox"
          class="w-full cursor-pointer justify-between font-normal"
          :disabled="disabled || loading || !versions.length"
        >
          <span :class="{ 'text-muted-foreground': !model }">
            {{ model || (loading ? 'Loading versions…' : 'Select version…') }}
          </span>
          <ChevronsUpDown class="size-4 opacity-50" aria-hidden="true" />
        </Button>
      </ComboboxTrigger>
    </ComboboxAnchor>
    <ComboboxList class="w-[var(--reka-combobox-trigger-width)]">
      <ComboboxInput placeholder="Search Minecraft version…" />
      <ComboboxEmpty>No Minecraft version found.</ComboboxEmpty>
      <ComboboxViewport>
        <ComboboxGroup>
          <ComboboxItem
            v-for="version in versions"
            :key="version"
            :value="version"
            class="cursor-pointer"
          >
            {{ version }}
            <ComboboxItemIndicator>
              <Check class="size-4" aria-hidden="true" />
            </ComboboxItemIndicator>
          </ComboboxItem>
        </ComboboxGroup>
      </ComboboxViewport>
    </ComboboxList>
  </Combobox>
</template>

<script setup lang="ts">
import { Button } from '@/components/ui/button'
import {
  Combobox,
  ComboboxAnchor,
  ComboboxEmpty,
  ComboboxGroup,
  ComboboxInput,
  ComboboxItem,
  ComboboxItemIndicator,
  ComboboxList,
  ComboboxTrigger,
  ComboboxViewport,
} from '@/components/ui/combobox'
import { Check, ChevronsUpDown } from '@lucide/vue'

defineProps<{
  id?: string
  versions: string[]
  loading?: boolean
  disabled?: boolean
}>()

const model = defineModel<string>({ required: true })
</script>
