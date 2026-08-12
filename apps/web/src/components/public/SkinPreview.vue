<template>
  <canvas ref="canvas" class="h-64 w-40 [image-rendering:pixelated]" width="160" height="256" aria-label="Предпросмотр скина" />
</template>

<script setup lang="ts">
import { onMounted, ref, watch } from 'vue'

const props = defineProps<{ src: string }>()
const canvas = ref<HTMLCanvasElement | null>(null)

const drawPart = (context: CanvasRenderingContext2D, image: HTMLImageElement, source: number[], target: number[]) => {
  context.drawImage(image, source[0]!, source[1]!, source[2]!, source[3]!, target[0]!, target[1]!, target[2]!, target[3]!)
}

const render = () => {
  const target = canvas.value
  if (!target) return
  const image = new Image()
  image.onload = () => {
    const context = target.getContext('2d')
    if (!context) return
    const unit = image.width / 64
    context.clearRect(0, 0, target.width, target.height)
    context.imageSmoothingEnabled = false
    const part = (source: number[], targetRect: number[]) => drawPart(context, image, source.map((value) => value * unit), targetRect)
    part([8, 8, 8, 8], [48, 8, 64, 64])
    part([20, 20, 8, 12], [48, 72, 64, 96])
    part([44, 20, 4, 12], [16, 72, 32, 96])
    part([36, 52, 4, 12], [112, 72, 32, 96])
    part([4, 20, 4, 12], [48, 168, 32, 88])
    part([20, 52, 4, 12], [80, 168, 32, 88])
    part([40, 8, 8, 8], [44, 4, 72, 72])
    part([20, 36, 8, 12], [44, 68, 72, 104])
    part([44, 36, 4, 12], [12, 68, 36, 104])
    part([52, 52, 4, 12], [112, 68, 36, 104])
    part([4, 36, 4, 12], [44, 164, 36, 92])
    part([4, 52, 4, 12], [80, 164, 36, 92])
  }
  image.src = props.src
}

onMounted(render)
watch(() => props.src, render)
</script>
