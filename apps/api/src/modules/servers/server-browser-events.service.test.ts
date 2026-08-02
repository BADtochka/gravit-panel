import { expect, test } from 'bun:test'
import type { ServerRuntimeEvent } from '@gravit-panel/shared'
import { ServerAgentEventHub } from './server-agent.events'
import { ServerBrowserEventsService } from './server-browser-events.service'

test('sends history as one frame and forwards live events across Elysia wrappers', () => {
  const history: ServerRuntimeEvent[] = [{
    sequence: 1,
    bindingId: 'binding',
    type: 'log.stdout',
    message: 'history',
    createdAt: new Date().toISOString(),
  }]
  const events = new ServerAgentEventHub()
  const service = new ServerBrowserEventsService(
    { listEvents: () => history },
    events,
  )
  const raw = {}
  const sent: Array<{ type: string; [key: string]: unknown }> = []
  const socket = () => ({
    raw,
    send: (data: unknown) => sent.push(JSON.parse(String(data))),
    close: () => {},
  })

  service.open(socket(), 'binding')
  events.publish({ ...history[0], sequence: 2, message: 'live' })
  service.message(socket(), { type: 'ping' })
  service.close(socket())
  events.publish({ ...history[0], sequence: 3, message: 'after close' })

  expect(sent[0]).toEqual({ type: 'history', events: history })
  expect(sent[1]).toMatchObject({ type: 'event', event: { sequence: 2, message: 'live' } })
  expect(sent[2]).toMatchObject({ type: 'pong' })
  expect(sent).toHaveLength(3)
})
