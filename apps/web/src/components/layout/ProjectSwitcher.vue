<template>
  <div class="space-y-2">
    <label class="text-xs font-medium text-muted-foreground" :for="selectId">
      Selected profile
    </label>
    <Select v-model="selectedInstallationId">
      <SelectTrigger :id="selectId" class="w-full">
        <SelectValue placeholder="Select profile" />
      </SelectTrigger>
      <SelectContent>
        <SelectItem v-for="item in installations" :key="item.id" :value="item.id">
          {{ item.name }} · {{ item.projectName }}
        </SelectItem>
      </SelectContent>
    </Select>
    <Button
      class="w-full"
      size="sm"
      type="button"
      variant="outline"
      @click="profileDialogOpen = true"
    >
        <Plus class="size-4" />
        Add profile
    </Button>
    <InstallationRemovalButton @removed="$emit('selected')" />

    <Dialog :open="profileDialogOpen" @update:open="updateProfileDialog">
      <DialogContent
        class="max-h-[calc(100vh-2rem)] max-w-[calc(100%-2rem)] overflow-y-auto p-4 sm:max-w-6xl md:p-6"
        @escape-key-down="preventBusyClose"
        @pointer-down-outside="preventBusyClose"
      >
        <DialogHeader class="sr-only">
          <DialogTitle>Add profile</DialogTitle>
          <DialogDescription>
            Check this host and create a complete GravitLauncher profile.
          </DialogDescription>
        </DialogHeader>
        <ProfileCreationWizard
          v-if="profileDialogOpen"
          @busy-change="profileCreationBusy = $event"
          @installed="profileCreated"
        />
      </DialogContent>
    </Dialog>
  </div>
</template>

<script setup lang="ts">
import InstallationRemovalButton from '@/components/layout/InstallationRemovalButton.vue'
import ProfileCreationWizard from '@/components/setup/ProfileCreationWizard.vue'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { useInstallationsStore } from '@/stores/installations'
import { Plus } from '@lucide/vue'
import { storeToRefs } from 'pinia'
import { ref } from 'vue'

const emit = defineEmits<{ selected: [] }>()
const store = useInstallationsStore()
const { installations, selectedInstallationId } = storeToRefs(store)
const selectId = `project-switcher-${crypto.randomUUID()}`
const profileDialogOpen = ref(false)
const profileCreationBusy = ref(false)

const updateProfileDialog = (open: boolean) => {
  if (!open && profileCreationBusy.value) return
  profileDialogOpen.value = open
}
const preventBusyClose = (event: Event) => {
  if (profileCreationBusy.value) event.preventDefault()
}

const profileCreated = () => {
  profileCreationBusy.value = false
  profileDialogOpen.value = false
  emit('selected')
}
</script>
