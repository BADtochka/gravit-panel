import { expect, test } from 'bun:test'
import type { JobEvent, JobRecord } from '@gravit-panel/shared'
import { JobsBrowserEventsService } from './jobs-browser-events.service'
import { JobsEventHub } from './jobs.events'

const job: JobRecord = {
  id: 'job-id',
  type: 'demo.noop',
  status: 'running',
  progress: 20,
  input: {},
  result: null,
  error: null,
  createdAt: '2026-08-02T00:00:00.000Z',
  startedAt: '2026-08-02T00:00:01.000Z',
  finishedAt: null,
}

const event = (sequence: number, type: JobEvent['type']): JobEvent => ({
  sequence,
  jobId: job.id,
  type,
  message: type,
  progress: type === 'completed' ? 100 : 20,
  createdAt: '2026-08-02T00:00:01.000Z',
})

const createSocket = () => {
  const sent: string[] = []
  const closed: Array<[number | undefined, string | undefined]> = []
  return {
    sent,
    closed,
    socket: {
      raw: {},
      send: (data: unknown) => sent.push(String(data)),
      close: (code?: number, reason?: string) => closed.push([code, reason]),
    },
  }
}

test('sends bounded history, live events, and closes on completion', () => {
  const hub = new JobsEventHub()
  let requestedLimit = 0
  const service = new JobsBrowserEventsService({
    get: () => job,
    listRecentEvents: (_jobId, limit) => {
      requestedLimit = limit ?? 0
      return [event(1, 'queued')]
    },
  }, hub)
  const { socket, sent, closed } = createSocket()

  service.open(socket, job.id)
  hub.publish(event(2, 'progress'))
  hub.publish(event(3, 'completed'))
  hub.publish(event(4, 'progress'))

  expect(requestedLimit).toBe(1000)
  expect(sent.map((message) => JSON.parse(message).type)).toEqual(['history', 'event', 'event'])
  expect(JSON.parse(sent[0]!).events).toEqual([event(1, 'queued')])
  expect(closed).toEqual([[1000, 'Job complete']])
})

test('answers heartbeats and rejects unknown jobs', () => {
  const service = new JobsBrowserEventsService({
    get: () => null,
    listRecentEvents: () => [],
  }, new JobsEventHub())
  const missing = createSocket()
  service.open(missing.socket, 'missing')
  expect(missing.closed).toEqual([[1008, 'Job not found']])

  const activeService = new JobsBrowserEventsService({
    get: () => job,
    listRecentEvents: () => [],
  }, new JobsEventHub())
  const active = createSocket()
  activeService.message(active.socket, JSON.stringify({ type: 'ping' }))
  expect(JSON.parse(active.sent[0]!).type).toBe('pong')
})
