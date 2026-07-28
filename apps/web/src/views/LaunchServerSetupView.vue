<template>
  <LaunchServerSetupWizard @installed="router.replace('/status')" />
</template>

<script setup lang="ts">
import LaunchServerSetupWizard from '@/components/setup/LaunchServerSetupWizard.vue'
import { useRouter } from 'vue-router'

const router = useRouter()
</script>
