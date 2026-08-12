<template>
  <section class="mx-auto max-w-3xl space-y-6">
    <div>
      <h2 class="text-2xl font-semibold tracking-tight">Публичная страница</h2>
      <p class="mt-1 text-sm text-muted-foreground">Настройте приветствие и доступные в личном кабинете сборки.</p>
    </div>

    <Card>
      <CardHeader>
        <CardTitle class="text-base">Приветствие</CardTitle>
        <CardDescription>Этот текст отображается на странице входа.</CardDescription>
      </CardHeader>
      <CardContent class="space-y-5">
        <div class="grid gap-2">
          <Label for="public-title">Заголовок</Label>
          <Input id="public-title" v-model="title" maxlength="120" />
        </div>
        <div class="grid gap-2">
          <Label for="public-description">Описание</Label>
          <textarea id="public-description" v-model="description" maxlength="500" class="min-h-28 rounded-md border bg-background px-3 py-2 text-sm outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50" />
          <p class="text-right text-xs text-muted-foreground">{{ description.length }}/500</p>
        </div>
      </CardContent>
    </Card>

    <Card>
      <CardHeader>
        <CardTitle class="text-base">Сборки лаунчера</CardTitle>
        <CardDescription>Включённые сборки появятся только у авторизованных игроков в личном кабинете.</CardDescription>
      </CardHeader>
      <CardContent class="space-y-3">
        <div v-for="variant in variants" :key="variant.id" class="flex items-center justify-between gap-4 rounded-md border p-4">
          <div>
            <p class="text-sm font-medium">{{ variant.label }}</p>
            <p class="text-xs text-muted-foreground">{{ variant.description }}</p>
          </div>
          <Switch :model-value="!hiddenVariants.includes(variant.id)" @update:model-value="setVariantVisible(variant.id, Boolean($event))" />
        </div>
      </CardContent>
      <CardFooter class="justify-between gap-4">
        <span class="text-sm text-muted-foreground">{{ message }}</span>
        <Button :disabled="saveMutation.isPending.value" @click="save">Сохранить</Button>
      </CardFooter>
    </Card>
  </section>
</template>

<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { useMutation, useQuery, useQueryClient } from '@tanstack/vue-query'
import { storeToRefs } from 'pinia'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Switch } from '@/components/ui/switch'
import { panelFetch } from '@/lib/public-path'
import { useLaunchServerStore } from '@/stores/launchserver'

type LauncherVariant = 'jar' | 'windows-x64'
interface Settings { title: string; description: string; hiddenLauncherVariants: LauncherVariant[] }
interface Artifact { variant: LauncherVariant }

const queryClient = useQueryClient()
const { launchServerId } = storeToRefs(useLaunchServerStore())
const title = ref('')
const description = ref('')
const hiddenVariants = ref<LauncherVariant[]>([])
const message = ref('')
const getJson = async <T>(url: string) => { const response = await panelFetch(url); if (!response.ok) throw new Error(`Request failed with status ${response.status}`); return response.json() as Promise<T> }
const { data: settings } = useQuery({ queryKey: ['public-page'], queryFn: () => getJson<Settings>('/api/public/settings') })
const { data: artifacts } = useQuery({ queryKey: computed(() => ['public-artifacts', launchServerId.value]), queryFn: () => getJson<{ items: Artifact[] }>(`/api/clients/launcher/artifacts?installationId=${encodeURIComponent(launchServerId.value)}`), enabled: computed(() => Boolean(launchServerId.value)), retry: false })
watch(settings, (value) => { if (value) { title.value = value.title; description.value = value.description; hiddenVariants.value = [...value.hiddenLauncherVariants] } }, { immediate: true })
const variants = computed(() => {
  const built = new Set(artifacts.value?.items.map((item) => item.variant) ?? [])
  return [
    { id: 'windows-x64' as const, label: 'Windows launcher', description: built.has('windows-x64') ? 'Основная сборка для Windows x64.' : 'Основная сборка для Windows x64. Ещё не собрана.' },
    { id: 'jar' as const, label: 'Java launcher', description: built.has('jar') ? 'Альтернативная сборка для других операционных систем.' : 'Альтернативная сборка для других операционных систем. Ещё не собрана.' },
  ]
})
const setVariantVisible = (variant: LauncherVariant, visible: boolean) => { hiddenVariants.value = visible ? hiddenVariants.value.filter((item) => item !== variant) : [...new Set([...hiddenVariants.value, variant])] }
const saveMutation = useMutation({ mutationFn: async () => { const response = await panelFetch('/api/public/settings', { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ title: title.value, description: description.value, hiddenLauncherVariants: hiddenVariants.value }) }); if (!response.ok) throw new Error('Не удалось сохранить настройки.') }, onSuccess: async () => { message.value = 'Сохранено.'; await queryClient.invalidateQueries({ queryKey: ['public-page'] }) }, onError: (error) => { message.value = error.message } })
const save = () => { message.value = ''; saveMutation.mutate() }
</script>
