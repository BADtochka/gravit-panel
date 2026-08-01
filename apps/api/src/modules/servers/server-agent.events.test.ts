import { expect, test } from 'bun:test'
import type { ServerRuntimeEvent } from '@gravit-panel/shared'
import { ServerAgentEventHub } from './server-agent.events'

test('merges history and events published during subscription in sequence order', async () => {
  const hub = new ServerAgentEventHub()
  const event = (sequence: number): ServerRuntimeEvent => ({
    sequence,
    bindingId: 'binding',
    type: 'log.stdout',
    message: `line ${sequence}`,
    createdAt: new Date().toISOString(),
  })
  const stream = hub.stream('binding', () => {
    hub.publish(event(2))
    return [event(1)]
  })

  const first = await stream.next()
  const second = await stream.next()
  await stream.return(undefined)

  expect(first.value?.data).toMatchObject({ sequence: 1 })
  expect(second.value?.data).toMatchObject({ sequence: 2 })
})
