<template>
  <div class="space-y-2">
    <label class="text-xs font-medium text-muted-foreground" :for="selectId">
      Client profile
    </label>
    <Select
      v-model="selectedProfileName"
      :disabled="isFetching || profiles.length === 0"
      @update:model-value="profileSelected"
    >
      <SelectTrigger :id="selectId" class="w-full">
        <SelectValue placeholder="No profiles yet" />
      </SelectTrigger>
      <SelectContent>
        <SelectItem v-for="item in profiles" :key="item.name" :value="item.name">
          {{ item.title }}
          <span v-if="item.title !== item.name" class="text-muted-foreground">
            · {{ item.name }}
          </span>
          <span v-if="item.minecraftVersion" class="text-muted-foreground">
            · {{ item.minecraftVersion }}<template v-if="item.loader"> / {{ item.loader }}</template>
          </span>
        </SelectItem>
      </SelectContent>
    </Select>
    <div class="grid grid-cols-2 gap-2">
      <Button size="sm" type="button" variant="outline" @click="addProfile">
        <Plus class="size-4" />
        New
      </Button>
      <Button
        size="sm"
        type="button"
        variant="outline"
        :disabled="!selectedProfileName"
        @click="manageProfile"
      >
        <Pencil class="size-4" />
        Manage
      </Button>
    </div>
    <p v-if="error" class="text-xs text-destructive">
      {{ error.message }}
    </p>
  </div>
</template>

<script setup lang="ts">
import { Button } from '@/components/ui/button'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { useClientProfiles } from '@/composables/useClientProfiles'
import { useProfilesStore } from '@/stores/profiles'
import { Pencil, Plus } from '@lucide/vue'
import { storeToRefs } from 'pinia'
import { useRouter } from 'vue-router'

// Client profiles of the single managed LaunchServer. The server itself is
// created once from the first-run wizard; this switcher only selects which
// game client profile the operational pages act on.
const emit = defineEmits<{ selected: [] }>()
const router = useRouter()
const profilesStore = useProfilesStore()
const { profiles, selectedProfileName } = storeToRefs(profilesStore)
const { error, isFetching } = useClientProfiles()
const selectId = `profile-switcher-${crypto.randomUUID()}`

const profileSelected = () => {
  profilesStore.consumeCreateRequest()
  emit('selected')
}

const addProfile = () => {
  emit('selected')
  profilesStore.requestCreate()
  void router.push('/panel/clients')
}

const manageProfile = () => {
  emit('selected')
  profilesStore.consumeCreateRequest()
  void router.push('/panel/clients')
}
</script>
