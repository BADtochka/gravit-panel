<template>
  <main class="mx-auto min-h-screen max-w-2xl px-4 py-12 md:px-6">
    <div class="mb-6">
      <Button as-child variant="outline">
        <RouterLink to="/"><ArrowLeft />Главная</RouterLink>
      </Button>
    </div>
    <Card v-if="sessionLoading"><CardContent class="p-6 text-sm text-muted-foreground">Проверка авторизации...</CardContent></Card>
    <Card v-else-if="!player"><CardHeader><CardTitle>Личный кабинет</CardTitle><CardDescription>Войдите через Discord, чтобы управлять скином игрового аккаунта.</CardDescription></CardHeader><CardFooter><Button @click="login"><LogIn />Войти через Discord</Button></CardFooter></Card>
    <Card v-else><CardHeader><div class="flex items-start justify-between gap-4"><div><CardTitle>{{ player.username }}</CardTitle><CardDescription>UUID: {{ player.playerUuid }}</CardDescription></div><Button variant="outline" size="sm" @click="logout">Выйти</Button></div></CardHeader><CardContent class="space-y-5"><div><p class="text-sm font-medium">Скин</p><p class="mt-1 text-sm text-muted-foreground">{{ skin ? `${skin.width}×${skin.height}, обновлён ${new Date(skin.updatedAt).toLocaleString()}` : 'Скин не загружен' }}</p></div><img v-if="skin" :src="panelUrl(`/api/public/skins/${player.username}.png`)" alt="Текущий скин" class="size-32 rounded border object-cover [image-rendering:pixelated]" /><label class="inline-flex h-9 cursor-pointer items-center gap-2 rounded-md border px-3 text-sm font-medium hover:bg-accent"><Upload />Загрузить PNG<input class="hidden" type="file" accept="image/png" @change="upload" /></label><p v-if="message" class="text-sm text-muted-foreground">{{ message }}</p></CardContent></Card>
  </main>
</template>

<script setup lang="ts">
import { computed, ref } from 'vue'
import { useQuery, useQueryClient } from '@tanstack/vue-query'
import { ArrowLeft, LogIn, Upload } from '@lucide/vue'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from '@/components/ui/card'
import { panelFetch, panelUrl } from '@/lib/public-path'

interface Player { playerUuid: string; username: string }
interface Skin { width: number; height: number; updatedAt: string }
const queryClient = useQueryClient()
const message = ref('')
const getJson = async <T>(url: string) => { const response = await panelFetch(url); if (!response.ok) throw new Error(`Request failed with status ${response.status}`); return response.json() as Promise<T> }
const { data: session, isLoading: sessionLoading } = useQuery({ queryKey: ['player-session'], queryFn: () => getJson<{ player: Player | null }>('/api/public/session') })
const player = computed(() => session.value?.player ?? null)
const { data: skin } = useQuery({ queryKey: ['player-skin'], queryFn: () => getJson<{ item: Skin | null }>('/api/public/skin').then((data) => data.item), enabled: computed(() => Boolean(player.value)), retry: false })
const login = () => window.location.assign(panelUrl('/api/public/auth/login'))
const logout = async () => { await panelFetch('/api/public/logout', { method: 'POST' }); await queryClient.invalidateQueries({ queryKey: ['player-session'] }) }
const upload = async (event: Event) => { const file = (event.target as HTMLInputElement).files?.[0]; if (!file) return; const form = new FormData(); form.set('file', file); const response = await panelFetch('/api/public/skin', { method: 'POST', body: form }); message.value = response.ok ? 'Скин сохранён.' : ((await response.json().catch(() => ({ message: 'Не удалось загрузить скин.' }))).message); if (response.ok) await queryClient.invalidateQueries({ queryKey: ['player-skin'] }) }
</script>
