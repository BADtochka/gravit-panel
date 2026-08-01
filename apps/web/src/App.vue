<template>
  <div class="min-h-screen bg-background text-foreground">
    <Toaster
      class="pointer-events-auto"
      position="bottom-right"
      :theme="theme"
      rich-colors
      close-button
    />
    <JobNotificationCenter />
    <div v-if="authLoading && !route.meta.public" class="grid min-h-screen place-items-center">
      <div class="flex items-center gap-2 text-sm text-muted-foreground">
        <LoaderCircle class="size-4 animate-spin" />
        Checking access…
      </div>
    </div>

    <main v-else-if="loginRequired && !route.meta.public" class="grid min-h-screen place-items-center p-4">
      <section class="w-full max-w-md rounded-xl border bg-card p-6 shadow-sm">
        <p class="text-sm font-medium text-muted-foreground">Gravit Panel</p>
        <h1 class="mt-2 text-2xl font-semibold tracking-tight">Sign in to continue</h1>
        <p class="mt-3 text-sm leading-6 text-muted-foreground">
          This panel is restricted to Discord accounts approved by its administrator.
        </p>
        <p v-if="authErrorMessage" class="mt-4 rounded-md border border-destructive/30 bg-destructive/10 p-3 text-sm text-destructive">
          {{ authErrorMessage }}
        </p>
        <Button as="a" :href="panelLoginUrl" class="mt-6 w-full">
          Continue with Discord
        </Button>
      </section>
    </main>

    <div v-else-if="launchServerLoading && !route.meta.public" class="grid min-h-screen place-items-center">
      <div class="flex items-center gap-2 text-sm text-muted-foreground">
        <LoaderCircle class="size-4 animate-spin" />
        Loading LaunchServer…
      </div>
    </div>

    <main v-else-if="route.meta.public" class="min-h-screen">
      <RouterView />
    </main>

    <main v-else-if="!hasLaunchServer" class="min-h-screen p-4 md:p-8">
      <div class="mx-auto max-w-7xl">
        <RouterView />
      </div>
    </main>

    <template v-else>
      <aside class="fixed inset-y-0 left-0 hidden w-64 border-r bg-card md:block">
        <div class="flex h-16 items-center gap-3 border-b px-4">
          <img
            :src="panelUrl('/gravit-panel-icon.png')"
            alt=""
            class="size-10 shrink-0 rounded-xl"
            aria-hidden="true"
          />
          <div class="min-w-0">
            <p class="text-sm font-semibold">Gravit Panel</p>
            <p class="text-xs text-muted-foreground">Admin workspace</p>
          </div>
        </div>
        <ProfileSwitcher class="border-b p-3" />
        <nav class="space-y-1 p-3">
          <RouterLink
            v-for="item in navItems"
            :key="item.to"
            :to="item.to"
            class="flex cursor-pointer items-center rounded-md px-3 py-2 text-sm text-muted-foreground hover:bg-accent hover:text-accent-foreground"
            active-class="bg-accent text-accent-foreground"
          >
            <component :is="item.icon" class="mr-3 size-4" aria-hidden="true" />
            {{ item.label }}
          </RouterLink>
        </nav>
      </aside>

      <main class="md:pl-64">
        <header class="flex h-16 items-center justify-between gap-3 border-b px-4 md:px-8">
          <div class="flex min-w-0 items-center gap-3">
            <Sheet v-model:open="mobileNavOpen">
              <SheetTrigger as-child>
                <Button
                  class="shrink-0 md:hidden"
                  variant="outline"
                  size="icon"
                  type="button"
                  title="Open navigation"
                  aria-label="Open navigation"
                >
                  <Menu class="size-4" aria-hidden="true" />
                </Button>
              </SheetTrigger>
              <SheetContent side="left" class="w-72 gap-0 p-0 sm:max-w-72">
                <SheetHeader class="flex h-16 flex-row items-center gap-3 border-b px-4 text-left">
                  <img
                    :src="panelUrl('/gravit-panel-icon.png')"
                    alt=""
                    class="size-10 shrink-0 rounded-xl"
                    aria-hidden="true"
                  />
                  <div class="min-w-0">
                    <SheetTitle class="text-sm">Gravit Panel</SheetTitle>
                    <SheetDescription class="text-xs">Admin workspace</SheetDescription>
                  </div>
                </SheetHeader>
                <ProfileSwitcher class="border-b p-3" @selected="mobileNavOpen = false" />
                <nav class="space-y-1 p-3">
                  <RouterLink
                    v-for="item in navItems"
                    :key="item.to"
                    :to="item.to"
                    class="flex cursor-pointer items-center rounded-md px-3 py-2 text-sm text-muted-foreground hover:bg-accent hover:text-accent-foreground"
                    active-class="bg-accent text-accent-foreground"
                    @click="mobileNavOpen = false"
                  >
                    <component :is="item.icon" class="mr-3 size-4" aria-hidden="true" />
                    {{ item.label }}
                  </RouterLink>
                </nav>
              </SheetContent>
            </Sheet>
            <div class="min-w-0">
              <h1 class="truncate text-base font-semibold">
                LaunchServer
              </h1>
              <p class="hidden truncate text-xs text-muted-foreground sm:block">
                {{ launchServer?.projectName }} · {{ launchServer?.address }}
              </p>
            </div>
          </div>
          <div class="flex shrink-0 items-center gap-2">
            <Button
              variant="outline"
              size="icon"
              type="button"
              :title="theme === 'dark' ? 'Switch to light theme' : 'Switch to dark theme'"
              :aria-label="theme === 'dark' ? 'Switch to light theme' : 'Switch to dark theme'"
              @click="toggleTheme"
            >
              <Sun v-if="theme === 'dark'" class="size-4" aria-hidden="true" />
              <Moon v-else class="size-4" aria-hidden="true" />
            </Button>
            <span class="hidden rounded-md border px-2 py-1 text-xs text-muted-foreground sm:inline">
              {{ panelAuth?.user?.globalName ?? panelAuth?.user?.username ?? 'Local' }}
            </span>
            <Button
              v-if="panelAuth?.enabled"
              variant="outline"
              size="sm"
              type="button"
              @click="logout"
            >
              Sign out
            </Button>
          </div>
        </header>

        <div class="p-4 md:p-8">
          <RouterView />
        </div>
      </main>
    </template>
  </div>
</template>

<script setup lang="ts">
import JobNotificationCenter from '@/components/jobs/JobNotificationCenter.vue'
import ProfileSwitcher from '@/components/layout/ProfileSwitcher.vue'
import { Button } from '@/components/ui/button'
import { Toaster } from '@/components/ui/sonner'
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
} from '@/components/ui/sheet'
import { resolveLaunchServerRedirect } from '@/lib/launchserver-routing'
import { panelFetch, panelUrl } from '@/lib/public-path'
import { useTheme } from '@/lib/theme'
import { useLaunchServerStore } from '@/stores/launchserver'
import type { GravitInstallation } from '@gravit-panel/shared'
import { useQuery } from '@tanstack/vue-query'
import {
  Activity,
  Blocks,
  Boxes,
  KeyRound,
  ListChecks,
  LoaderCircle,
  Menu,
  Moon,
  PackageSearch,
  FilePenLine,
  Rocket,
  ServerCog,
  Sun,
  Users,
} from '@lucide/vue'
import { storeToRefs } from 'pinia'
import { computed, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import 'vue-sonner/style.css'

interface LaunchServerResponse {
  item: GravitInstallation | null
}

interface PanelAuthSession {
  enabled: boolean
  configured: boolean
  authenticated: boolean
  user: {
    discordId: string
    username: string
    globalName: string | null
    avatarHash: string | null
  } | null
}

const { theme, toggleTheme } = useTheme()
const launchServerStore = useLaunchServerStore()
const { launchServer } = storeToRefs(launchServerStore)
const mobileNavOpen = ref(false)
const route = useRoute()
const router = useRouter()

const getPanelAuthSession = async () => {
  const response = await panelFetch('/api/panel-auth/session')
  if (!response.ok) throw new Error(`Authentication request failed with status ${response.status}`)
  return response.json() as Promise<PanelAuthSession>
}

const { data: panelAuth, isLoading: authLoading } = useQuery({
  queryKey: ['panel-auth-session'],
  queryFn: getPanelAuthSession,
})
const loginRequired = computed(
  () => Boolean(panelAuth.value?.enabled) && !panelAuth.value?.authenticated,
)
const panelLoginUrl = computed(
  () => `${panelUrl('/api/panel-auth/login')}?returnTo=${encodeURIComponent(route.fullPath)}`,
)
const authErrorMessage = computed(() => {
  const error = route.query.authError
  if (error === 'not-authorized') return 'This Discord account is not on the access list.'
  if (error === 'state') return 'The sign-in request expired. Please try again.'
  if (error === 'configuration') return 'Discord sign-in is not configured yet.'
  if (error === 'discord') return 'Discord sign-in failed. Please try again.'
  return null
})

const logout = async () => {
  await panelFetch('/api/panel-auth/logout', { method: 'POST' })
  window.location.assign(panelUrl(route.fullPath))
}

const getLaunchServer = async () => {
  const response = await panelFetch('/api/docker/launchserver')
  if (!response.ok) throw new Error(`LaunchServer request failed with status ${response.status}`)
  return response.json() as Promise<LaunchServerResponse>
}

const { data, isLoading: launchServerLoading } = useQuery({
  queryKey: ['docker-launchserver'],
  queryFn: getLaunchServer,
  enabled: computed(
    () => panelAuth.value !== undefined && (!panelAuth.value.enabled || panelAuth.value.authenticated),
  ),
})
watch(
  [() => data.value?.item, () => route.path],
  ([item, path]) => {
    if (item === undefined) return
    launchServerStore.setLaunchServer(item)
    const redirect = resolveLaunchServerRedirect(path, Boolean(item))
    if (redirect) void router.replace(redirect)
  },
  { immediate: true },
)
const hasLaunchServer = computed(() => Boolean(launchServer.value))

const navItems = [
  { to: '/status', label: 'Status', icon: Activity },
  { to: '/jobs', label: 'Jobs', icon: ListChecks },
  { to: '/modules', label: 'Modules', icon: Blocks },
  { to: '/auth', label: 'Auth', icon: KeyRound },
  { to: '/users', label: 'Users', icon: Users },
  { to: '/launcher', label: 'Launcher', icon: Rocket },
  { to: '/clients', label: 'Clients', icon: Boxes },
  { to: '/servers', label: 'Servers', icon: ServerCog },
  { to: '/mods', label: 'Mods', icon: PackageSearch },
  { to: '/public-settings', label: 'Public page', icon: FilePenLine },
]
</script>
