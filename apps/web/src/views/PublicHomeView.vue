<template>
  <main class="mx-auto flex min-h-screen max-w-5xl flex-col px-4 py-8 md:px-6 md:py-12">
    <header class="flex items-center justify-between gap-4">
      <span class="text-sm font-semibold tracking-wide">
        {{ page?.title || currentInstallation?.projectName || 'Лаунчер' }}
      </span>
      <RouterLink
        v-if="player"
        to="/account"
        class="flex items-center gap-2 rounded-full border bg-card py-1 pl-1 pr-3 text-sm font-medium transition-colors hover:bg-accent"
      >
        <img
          :src="discordAvatarUrl(player.discordId)"
          :alt="`Аватар ${player.username}`"
          class="size-8 rounded-full bg-muted object-cover"
        />
        <span class="max-w-32 truncate">{{ player.username }}</span>
        <UserRound class="size-4 text-muted-foreground" />
      </RouterLink>
      <Button v-else size="sm" @click="login"><LogIn />Войти</Button>
    </header>

    <section class="my-auto grid gap-10 py-20 lg:grid-cols-[minmax(0,1fr)_22rem] lg:items-center">
      <div class="max-w-2xl">
        <p class="mb-4 text-sm font-medium text-primary">Игровой сервер</p>
        <h1 class="text-4xl font-semibold tracking-tight sm:text-6xl">
          {{ page?.title || currentInstallation?.projectName || 'Лаунчер' }}
        </h1>
        <p class="mt-6 max-w-xl text-base leading-7 text-muted-foreground sm:text-lg">
          {{ page?.description || 'Войдите в личный кабинет, чтобы скачать лаунчер и управлять игровым профилем.' }}
        </p>
      </div>

      <Card class="border-primary/20 shadow-lg shadow-primary/5">
        <CardHeader>
          <CardTitle>{{ player ? `С возвращением, ${player.username}` : 'Начать играть' }}</CardTitle>
          <CardDescription>
            {{ player ? 'Лаунчер и настройки профиля доступны в личном кабинете.' : 'Авторизуйтесь через Discord, чтобы открыть личный кабинет и скачать лаунчер.' }}
          </CardDescription>
        </CardHeader>
        <CardFooter>
          <Button v-if="player" as-child class="w-full">
            <RouterLink to="/account"><UserRound />Открыть кабинет</RouterLink>
          </Button>
          <Button v-else class="w-full" @click="login"><LogIn />Войти через Discord</Button>
        </CardFooter>
      </Card>
    </section>
  </main>
</template>

<script setup lang="ts">
import { computed, watchEffect } from 'vue'
import { useQuery } from '@tanstack/vue-query'
import { storeToRefs } from 'pinia'
import { LogIn, UserRound } from '@lucide/vue'
import { Button } from '@/components/ui/button'
import { Card, CardDescription, CardFooter, CardHeader, CardTitle } from '@/components/ui/card'
import { panelFetch, panelUrl } from '@/lib/public-path'
import { useLaunchServerStore } from '@/stores/launchserver'
import type { GravitInstallation } from '@gravit-panel/shared'

interface Page { title: string; description: string }
interface Player { username: string; discordId: string }

const { launchServer: installation } = storeToRefs(useLaunchServerStore())
const getJson = async <T>(url: string) => {
  const response = await panelFetch(url)
  if (!response.ok) throw new Error(`Request failed with status ${response.status}`)
  return response.json() as Promise<T>
}
const { data: publicInstallation } = useQuery({ queryKey: ['public-launchserver'], queryFn: () => getJson<{ item: GravitInstallation | null }>('/api/docker/launchserver') })
const currentInstallation = computed(() => publicInstallation.value?.item ?? installation.value)
const { data: page } = useQuery({ queryKey: ['public-page'], queryFn: () => getJson<Page>('/api/public/page') })
const { data: session } = useQuery({ queryKey: ['player-session'], queryFn: () => getJson<{ player: Player | null }>('/api/public/session') })
const player = computed(() => session.value?.player ?? null)
const discordAvatarUrl = (discordId: string) =>
  `https://cdn.discordapp.com/embed/avatars/${Number(BigInt(discordId) >> 22n) % 6}.png`
const login = () => window.location.assign(panelUrl('/api/public/auth/login'))

watchEffect(() => {
  document.title = page.value?.title || currentInstallation.value?.projectName || 'Лаунчер'
})
</script>
