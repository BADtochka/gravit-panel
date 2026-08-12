<template>
  <main class="mx-auto min-h-screen max-w-4xl px-4 py-10 md:px-6">
    <div class="mb-8 flex items-center justify-between gap-4">
      <Button as-child variant="outline"><RouterLink to="/"><ArrowLeft />Главная</RouterLink></Button>
      <Button v-if="player" variant="ghost" size="sm" @click="logout">Выйти</Button>
    </div>

    <Card v-if="sessionLoading">
      <CardContent class="p-6 text-sm text-muted-foreground">Проверка авторизации...</CardContent>
    </Card>
    <Card v-else-if="!player" class="mx-auto max-w-lg">
      <CardHeader>
        <CardTitle>Личный кабинет</CardTitle>
        <CardDescription>Войдите через Discord, чтобы скачать лаунчер и управлять игровым профилем.</CardDescription>
      </CardHeader>
      <CardFooter><Button class="w-full" @click="login"><LogIn />Войти через Discord</Button></CardFooter>
    </Card>

    <template v-else>
      <div class="mb-8">
        <h1 class="text-3xl font-semibold tracking-tight">{{ player.username }}</h1>
        <p class="mt-1 font-mono text-xs text-muted-foreground">{{ player.playerUuid }}</p>
      </div>

      <div class="grid gap-6 md:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle>Скачать лаунчер</CardTitle>
            <CardDescription>Выберите версию для вашей операционной системы.</CardDescription>
          </CardHeader>
          <CardContent class="space-y-3">
            <p v-if="artifactsLoading" class="text-sm text-muted-foreground">Загрузка сборок...</p>
            <template v-else-if="visibleArtifacts.length">
              <div v-if="windowsArtifact" class="rounded-lg border border-primary/30 bg-primary/5 p-4">
                <div class="mb-4">
                  <p class="font-medium">Windows</p>
                  <p class="text-xs text-muted-foreground">{{ windowsArtifact.filename }} · {{ formatBytes(windowsArtifact.size) }}</p>
                </div>
                <Button as="a" :href="panelUrl(windowsArtifact.downloadPath)" class="w-full"><Download />Скачать для Windows</Button>
              </div>
              <div v-if="javaArtifact" class="rounded-lg border bg-muted/40 p-4 text-muted-foreground">
                <div class="mb-4">
                  <p class="font-medium text-foreground">Другие ОС</p>
                  <p class="text-xs">Java · {{ javaArtifact.filename }} · {{ formatBytes(javaArtifact.size) }}</p>
                </div>
                <Button as="a" :href="panelUrl(javaArtifact.downloadPath)" variant="secondary" class="w-full"><Download />Скачать Java launcher</Button>
              </div>
            </template>
            <p v-else class="text-sm text-muted-foreground">Доступных сборок пока нет.</p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader><CardTitle>Скин</CardTitle><CardDescription>PNG 64×64 или 64×32.</CardDescription></CardHeader>
          <CardContent class="space-y-5">
            <p class="text-sm text-muted-foreground">{{ skin ? `${skin.width}×${skin.height}, обновлён ${new Date(skin.updatedAt).toLocaleString()}` : 'Скин не загружен' }}</p>
            <div v-if="skin" class="flex justify-center rounded-lg border bg-muted/30 p-4">
              <SkinPreview :src="skinUrl" />
            </div>
            <label class="inline-flex h-9 cursor-pointer items-center gap-2 rounded-md border px-3 text-sm font-medium hover:bg-accent"><Upload />Загрузить PNG<input class="hidden" type="file" accept="image/png" @change="upload" /></label>
            <p v-if="message" class="text-sm text-muted-foreground">{{ message }}</p>
          </CardContent>
        </Card>
      </div>
    </template>
  </main>
</template>

<script setup lang="ts">
import { computed, ref } from 'vue'
import { useQuery, useQueryClient } from '@tanstack/vue-query'
import { ArrowLeft, Download, LogIn, Upload } from '@lucide/vue'
import { Button } from '@/components/ui/button'
import SkinPreview from '@/components/public/SkinPreview.vue'
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from '@/components/ui/card'
import { panelFetch, panelUrl } from '@/lib/public-path'
import type { GravitInstallation } from '@gravit-panel/shared'

interface Player { playerUuid: string; username: string; discordId: string; avatarHash: string | null }
interface Skin { width: number; height: number; updatedAt: string }
interface Page { hiddenLauncherVariants: string[] }
interface Artifact { variant: 'jar' | 'windows-x64'; filename: string; size: number; downloadPath: string }

const queryClient = useQueryClient()
const message = ref('')
const getJson = async <T>(url: string) => {
  const response = await panelFetch(url)
  if (!response.ok) throw new Error(`Request failed with status ${response.status}`)
  return response.json() as Promise<T>
}
const { data: session, isLoading: sessionLoading } = useQuery({ queryKey: ['player-session'], queryFn: () => getJson<{ player: Player | null }>('/api/public/session') })
const player = computed(() => session.value?.player ?? null)
const { data: skin } = useQuery({ queryKey: ['player-skin'], queryFn: () => getJson<{ item: Skin | null }>('/api/public/skin').then((data) => data.item), enabled: computed(() => Boolean(player.value)), retry: false })
const { data: page } = useQuery({ queryKey: ['public-page'], queryFn: () => getJson<Page>('/api/public/page'), enabled: computed(() => Boolean(player.value)) })
const { data: installation } = useQuery({ queryKey: ['public-launchserver'], queryFn: () => getJson<{ item: GravitInstallation | null }>('/api/docker/launchserver'), enabled: computed(() => Boolean(player.value)) })
const { data: artifacts, isLoading: artifactsLoading } = useQuery({ queryKey: computed(() => ['public-artifacts', installation.value?.item?.id]), queryFn: () => getJson<{ items: Artifact[] }>(`/api/clients/launcher/artifacts?installationId=${encodeURIComponent(installation.value!.item!.id)}`), enabled: computed(() => Boolean(player.value && installation.value?.item?.id)), retry: false })
const visibleArtifacts = computed(() => artifacts.value?.items.filter((item) => !page.value?.hiddenLauncherVariants.includes(item.variant)) ?? [])
const windowsArtifact = computed(() => visibleArtifacts.value.find((item) => item.variant === 'windows-x64'))
const javaArtifact = computed(() => visibleArtifacts.value.find((item) => item.variant === 'jar'))
const skinUrl = computed(() => panelUrl(`/api/public/skins/${player.value!.username}.png?v=${skin.value?.updatedAt ?? ''}`))
const formatBytes = (bytes: number) => `${(bytes / 1024 / 1024).toFixed(1)} MB`
const login = () => window.location.assign(panelUrl('/api/public/auth/login'))
const logout = async () => { await panelFetch('/api/public/logout', { method: 'POST' }); await queryClient.invalidateQueries({ queryKey: ['player-session'] }) }
const upload = async (event: Event) => { const file = (event.target as HTMLInputElement).files?.[0]; if (!file) return; const form = new FormData(); form.set('file', file); const response = await panelFetch('/api/public/skin', { method: 'POST', body: form }); message.value = response.ok ? 'Скин сохранён.' : ((await response.json().catch(() => ({ message: 'Не удалось загрузить скин.' }))).message); if (response.ok) await queryClient.invalidateQueries({ queryKey: ['player-skin'] }) }
</script>
