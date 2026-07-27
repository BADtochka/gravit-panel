<template>
  <ProfileCreationWizard @installed="router.replace('/status')" />
</template>

<script setup lang="ts">
import ProfileCreationWizard from '@/components/setup/ProfileCreationWizard.vue'
import { useRouter } from 'vue-router'

const router = useRouter()
</script>
