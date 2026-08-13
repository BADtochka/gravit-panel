<template>
  <div class="space-y-2">
    <label class="text-xs font-medium text-muted-foreground" :for="selectId">Game server</label>
    <Select v-model="selectedBindingKey" :disabled="isFetching || bindings.length === 0" @update:model-value="emit('selected')">
      <SelectTrigger :id="selectId" class="w-full"><SelectValue placeholder="No servers yet" /></SelectTrigger>
      <SelectContent>
        <SelectItem v-for="binding in bindings" :key="serverBindingKey(binding)" :value="serverBindingKey(binding)">
          {{ binding.name }}
          <span class="text-muted-foreground"> · {{ binding.serverAddress }}:{{ binding.serverPort }}</span>
        </SelectItem>
      </SelectContent>
    </Select>
    <div class="grid grid-cols-2 gap-2">
      <Button size="sm" type="button" variant="outline" :disabled="!selectedProfileName" @click="addServer"><Plus />New</Button>
      <Button size="sm" type="button" variant="outline" :disabled="!selectedBindingKey" @click="manageServer"><Pencil />Manage</Button>
    </div>
    <p v-if="error" class="text-xs text-destructive">{{ error.message }}</p>
  </div>
</template>

<script setup lang="ts">
import { Button } from '@/components/ui/button'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { useServerBindings } from '@/composables/useServerBindings'
import { useProfilesStore } from '@/stores/profiles'
import { serverBindingKey, useServersStore } from '@/stores/servers'
import { Pencil, Plus } from '@lucide/vue'
import { storeToRefs } from 'pinia'
import { useRouter } from 'vue-router'

const emit = defineEmits<{ selected: [] }>()
const router = useRouter()
const { selectedProfileName } = storeToRefs(useProfilesStore())
const serversStore = useServersStore()
const { bindings, selectedBindingKey } = storeToRefs(serversStore)
const { error, isFetching } = useServerBindings()
const selectId = `server-switcher-${crypto.randomUUID()}`
const addServer = () => { emit('selected'); serversStore.requestCreate(); void router.push('/panel/server/overview') }
const manageServer = () => { emit('selected'); serversStore.requestEdit(); void router.push('/panel/server/overview') }
</script>
