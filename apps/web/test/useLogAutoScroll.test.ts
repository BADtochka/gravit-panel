import { expect, test } from 'bun:test'
import { nextTick, ref } from 'vue'
import { useLogAutoScroll } from '../src/composables/useLogAutoScroll'

test('auto-scroll follows new events only while enabled', async () => {
  const eventCount = ref(0)
  const { autoScroll, logContainer } = useLogAutoScroll(() => eventCount.value)
  const container = {
    scrollHeight: 100,
    scrollTop: 0,
  } as HTMLElement

  logContainer.value = container
  eventCount.value += 1
  await nextTick()
  expect(container.scrollTop).toBe(100)

  autoScroll.value = false
  Object.defineProperty(container, 'scrollHeight', { configurable: true, value: 200 })
  eventCount.value += 1
  await nextTick()
  expect(container.scrollTop).toBe(100)

  autoScroll.value = true
  await nextTick()
  expect(container.scrollTop).toBe(200)
})
