import { expect, test } from 'bun:test'
import type { ServerRuntimeEvent } from '@gravit-panel/shared'
import { ServerAgentEventHub } from './server-agent.events'

test('publishes events until a subscriber disconnects', () => {
  const hub = new ServerAgentEventHub()
  const event = (sequence: number): ServerRuntimeEvent => ({
    sequence,
    bindingId: 'binding',
    type: 'log.stdout',
    message: `line ${sequence}`,
    createdAt: new Date().toISOString(),
  })
  const received: ServerRuntimeEvent[] = []
  const unsubscribe = hub.subscribe('binding', (value) => received.push(value))
  hub.publish(event(1))
  unsubscribe()
  hub.publish(event(2))

  expect(received.map((value) => value.sequence)).toEqual([1])
})
