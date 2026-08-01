<template>
  <main class="mx-auto min-h-screen max-w-5xl px-4 py-16 md:px-6">
    <div class="mb-10 flex justify-end">
      <RouterLink to="/account" class="inline-flex h-9 items-center rounded-md border px-3 text-sm font-medium hover:bg-accent">
        {{ player ? `Кабинет: ${player.username}` : 'Войти через Discord' }}
      </RouterLink>
    </div>
    <section class="max-w-2xl">
      <h1 class="text-4xl font-semibold tracking-tight">{{ page?.title || currentInstallation?.projectName || 'Лаунчер' }}</h1>
      <p v-if="page?.description" class="mt-4 text-base leading-7 text-muted-foreground">{{ page.description }}</p>
    </section>
    <section class="mt-12">
      <div v-if="artifactsLoading" class="text-sm text-muted-foreground">Загрузка доступных лаунчеров...</div>
      <div v-else-if="visibleArtifacts.length" class="grid gap-4 md:grid-cols-2">
        <Card v-for="artifact in visibleArtifacts" :key="artifact.variant">
          <CardHeader><CardTitle>{{ artifact.variant === 'windows-x64' ? 'Windows launcher' : 'Java launcher' }}</CardTitle><CardDescription>{{ artifact.filename }} · {{ formatBytes(artifact.size) }}</CardDescription></CardHeader>
          <CardFooter><Button v-if="player" as="a" :href="panelUrl(artifact.downloadPath)"><Download />Скачать</Button><Button v-else @click="login"><LogIn />Войти, чтобы скачать</Button></CardFooter>
        </Card>
      </div>
      <p v-else class="text-sm text-muted-foreground">Доступных для скачивания лаунчеров пока нет.</p>
    </section>
  </main>
</template>

<script setup lang="ts">
import { computed, watchEffect } from 'vue'
import { useQuery } from '@tanstack/vue-query'
import { storeToRefs } from 'pinia'
import { Download, LogIn } from '@lucide/vue'
import { Button } from '@/components/ui/button'
import { Card, CardDescription, CardFooter, CardHeader, CardTitle } from '@/components/ui/card'
import { panelFetch, panelUrl } from '@/lib/public-path'
import { useLaunchServerStore } from '@/stores/launchserver'
import type { GravitInstallation } from '@gravit-panel/shared'

interface Page { title: string; description: string; hiddenLauncherVariants: string[] }
interface Artifact { variant: 'jar' | 'windows-x64'; filename: string; size: number; downloadPath: string }
interface Player { username: string }
const { launchServer: installation } = storeToRefs(useLaunchServerStore())
const getJson = async <T>(url: string) => { const response = await panelFetch(url); if (!response.ok) throw new Error(`Request failed with status ${response.status}`); return response.json() as Promise<T> }
const { data: publicInstallation } = useQuery({ queryKey: ['public-launchserver'], queryFn: () => getJson<{ item: GravitInstallation | null }>('/api/docker/launchserver') })
const currentInstallation = computed(() => publicInstallation.value?.item ?? installation.value)
const { data: page } = useQuery({ queryKey: ['public-page'], queryFn: () => getJson<Page>('/api/public/page') })
const { data: session } = useQuery({ queryKey: ['player-session'], queryFn: () => getJson<{ player: Player | null }>('/api/public/session') })
const player = computed(() => session.value?.player ?? null)
const { data: artifacts, isLoading: artifactsLoading } = useQuery({ queryKey: computed(() => ['public-artifacts', currentInstallation.value?.id]), queryFn: () => getJson<{ items: Artifact[] }>(`/api/clients/launcher/artifacts?installationId=${encodeURIComponent(currentInstallation.value!.id)}`), enabled: computed(() => Boolean(currentInstallation.value?.id)), retry: false })
const visibleArtifacts = computed(() => artifacts.value?.items.filter((item) => !page.value?.hiddenLauncherVariants.includes(item.variant)) ?? [])
const formatBytes = (bytes: number) => `${(bytes / 1024 / 1024).toFixed(1)} MB`
const login = () => window.location.assign(panelUrl('/api/public/auth/login'))

watchEffect(() => {
  document.title = page.value?.title || currentInstallation.value?.projectName || 'Лаунчер'
})
</script>
