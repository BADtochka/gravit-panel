<template>
  <div class="mx-auto max-w-3xl space-y-6">
    <div><h2 class="text-2xl font-semibold tracking-tight">Публичная страница</h2><p class="mt-1 text-sm text-muted-foreground">Настройте заголовок, описание и видимость собранных лаунчеров.</p></div>
    <Card><CardHeader><CardTitle>Содержимое</CardTitle></CardHeader><CardContent class="space-y-5"><label class="grid gap-2 text-sm font-medium">Заголовок<Input v-model="title" maxlength="120" /></label><label class="grid gap-2 text-sm font-medium">Описание<textarea v-model="description" maxlength="500" class="min-h-28 rounded-md border bg-background px-3 py-2 text-sm outline-none focus-visible:border-ring focus-visible:ring-ring/50 focus-visible:ring-3" /></label></CardContent></Card>
    <Card><CardHeader><CardTitle>Карточки лаунчера</CardTitle><CardDescription>Показываются только артефакты, собранные для текущей установки.</CardDescription></CardHeader><CardContent class="space-y-3"><label v-for="variant in variants" :key="variant.id" class="flex items-center justify-between rounded-md border p-3 text-sm"><span>{{ variant.label }}</span><input v-model="hiddenVariants" :value="variant.id" type="checkbox" class="size-4" /><span class="text-muted-foreground">Скрыть</span></label><p v-if="!variants.length" class="text-sm text-muted-foreground">Собранные артефакты не найдены.</p></CardContent><CardFooter class="justify-between"><span class="text-sm text-muted-foreground">{{ message }}</span><Button :disabled="saveMutation.isPending" @click="save">Сохранить</Button></CardFooter></Card>
  </div>
</template>

<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { useMutation, useQuery, useQueryClient } from '@tanstack/vue-query'
import { storeToRefs } from 'pinia'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { panelFetch } from '@/lib/public-path'
import { useLaunchServerStore } from '@/stores/launchserver'

interface Settings { title: string; description: string; hiddenLauncherVariants: Array<'jar' | 'windows-x64'> }
interface Artifact { variant: 'jar' | 'windows-x64' }
const queryClient = useQueryClient()
const { launchServerId } = storeToRefs(useLaunchServerStore())
const title = ref('')
const description = ref('')
const hiddenVariants = ref<Array<'jar' | 'windows-x64'>>([])
const message = ref('')
const getJson = async <T>(url: string) => { const response = await panelFetch(url); if (!response.ok) throw new Error(`Request failed with status ${response.status}`); return response.json() as Promise<T> }
const { data: settings } = useQuery({ queryKey: ['public-page'], queryFn: () => getJson<Settings>('/api/public/settings') })
const { data: artifacts } = useQuery({ queryKey: computed(() => ['public-artifacts', launchServerId.value]), queryFn: () => getJson<{ items: Artifact[] }>(`/api/clients/launcher/artifacts?installationId=${encodeURIComponent(launchServerId.value)}`), enabled: computed(() => Boolean(launchServerId.value)), retry: false })
watch(settings, (value) => { if (value) { title.value = value.title; description.value = value.description; hiddenVariants.value = value.hiddenLauncherVariants } }, { immediate: true })
const variants = computed(() => artifacts.value?.items.map((item) => ({ id: item.variant, label: item.variant === 'windows-x64' ? 'Windows launcher' : 'Java launcher' })) ?? [])
const saveMutation = useMutation({ mutationFn: async () => { const response = await panelFetch('/api/public/settings', { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ title: title.value, description: description.value, hiddenLauncherVariants: hiddenVariants.value }) }); if (!response.ok) throw new Error('Не удалось сохранить настройки.') }, onSuccess: async () => { message.value = 'Сохранено.'; await queryClient.invalidateQueries({ queryKey: ['public-page'] }) }, onError: (error) => { message.value = error.message } })
const save = () => saveMutation.mutate()
</script>
