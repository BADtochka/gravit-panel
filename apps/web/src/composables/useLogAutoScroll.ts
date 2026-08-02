import { ref, watch, type Ref } from 'vue'

export const useLogAutoScroll = (eventCount: () => number) => {
  const autoScroll = ref(true)
  const logContainer: Ref<HTMLElement | null> = ref(null)

  const scrollToLatest = () => {
    if (!autoScroll.value) return
    const container = logContainer.value
    if (container) container.scrollTop = container.scrollHeight
  }

  watch(eventCount, scrollToLatest, { flush: 'post' })
  watch(autoScroll, (enabled) => {
    if (enabled) scrollToLatest()
  }, { flush: 'post' })

  return { autoScroll, logContainer, scrollToLatest }
}
