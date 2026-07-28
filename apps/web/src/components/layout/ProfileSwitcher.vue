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
          {{ item.name }}
          <span v-if="item.minecraftVersion" class="text-muted-foreground">
            · {{ item.minecraftVersion }}<template v-if="item.loader"> / {{ item.loader }}</template>
          </span>
        </SelectItem>
      </SelectContent>
    </Select>
    <Button
      class="w-full"
      size="sm"
      type="button"
      variant="outline"
      @click="addProfile"
    >
      <Plus class="size-4" />
      New profile
    </Button>
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
import { Plus } from '@lucide/vue'
import { storeToRefs } from 'pinia'
import { useRoute, useRouter } from 'vue-router'

// Client profiles of the single managed LaunchServer. The server itself is
// created once from the first-run wizard; this switcher only selects which
// game client profile the operational pages act on.
const emit = defineEmits<{ selected: [] }>()
const route = useRoute()
const router = useRouter()
const { profiles, selectedProfileName } = storeToRefs(useProfilesStore())
const { error, isFetching } = useClientProfiles()
const selectId = `profile-switcher-${crypto.randomUUID()}`

const profileSelected = () => {
  if (route.path === '/clients' && route.query.new) {
    void router.replace('/clients')
  }
  emit('selected')
}

const addProfile = () => {
  emit('selected')
  void router.push({ path: '/clients', query: { new: crypto.randomUUID() } })
}
</script>
