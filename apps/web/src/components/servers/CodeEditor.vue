<template>
  <div ref="host" class="min-h-0 min-w-0 flex-1 overflow-hidden text-xs sm:text-sm" />
</template>

<script setup lang="ts">
import { basicSetup } from 'codemirror'
import { Compartment, EditorState } from '@codemirror/state'
import { EditorView, keymap, type ViewUpdate } from '@codemirror/view'
import { onBeforeUnmount, onMounted, ref, watch } from 'vue'

const props = defineProps<{ modelValue: string; disabled?: boolean }>()
const emit = defineEmits<{ 'update:modelValue': [value: string]; save: [] }>()
const host = ref<HTMLElement | null>(null)
let editor: EditorView | null = null
const editable = new Compartment()

onMounted(() => {
  editor = new EditorView({
    parent: host.value!,
    state: EditorState.create({
      doc: props.modelValue,
      extensions: [
        basicSetup,
        EditorView.lineWrapping,
        editable.of(EditorView.editable.of(!props.disabled)),
        keymap.of([{ key: 'Mod-s', preventDefault: true, run: () => { emit('save'); return true } }]),
        EditorView.updateListener.of((update: ViewUpdate) => {
          if (update.docChanged) emit('update:modelValue', update.state.doc.toString())
        }),
      ],
    }),
  })
})

watch(() => props.modelValue, (value) => {
  if (!editor || editor.state.doc.toString() === value) return
  editor.dispatch({ changes: { from: 0, to: editor.state.doc.length, insert: value } })
})
watch(() => props.disabled, (disabled) => {
  editor?.dispatch({ effects: editable.reconfigure(EditorView.editable.of(!disabled)) })
})

onBeforeUnmount(() => editor?.destroy())
</script>

<style scoped>
:deep(.cm-editor) { height: 100%; min-height: 0; background: transparent; }
:deep(.cm-scroller) { overflow: auto; overscroll-behavior: contain; -webkit-overflow-scrolling: touch; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; }
:deep(.cm-content) { min-width: 0; padding-bottom: max(1rem, env(safe-area-inset-bottom)); }
:deep(.cm-gutterElement) { padding-inline: 3px; }
@media (min-width: 640px) { :deep(.cm-gutterElement) { padding-inline: 5px; } }
:deep(.cm-gutters) { background: hsl(var(--muted) / 0.35); border-right-color: hsl(var(--border)); }
:deep(.cm-focused) { outline: none; }
</style>
