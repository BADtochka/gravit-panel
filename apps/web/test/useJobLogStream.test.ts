import { expect, test } from 'bun:test'
import type { JobEvent, JobRecord } from '@gravit-panel/shared'
import { effectScope, nextTick, ref } from 'vue'
import { useJobLogStream } from '../src/composables/useJobLogStream'

const job = (status: JobRecord['status']): JobRecord => ({
  id: 'workspace-job',
  type: 'gravit.workspace.apply',
  status,
  progress: status === 'succeeded' ? 100 : 0,
  input: { installationId: 'installation-id' },
  result: status === 'succeeded' ? { installationId: 'installation-id' } : null,
  error: null,
  createdAt: '2026-07-27T12:00:00.000Z',
  startedAt: status === 'queued' ? null : '2026-07-27T12:00:01.000Z',
  finishedAt: status === 'succeeded' ? '2026-07-27T12:00:02.000Z' : null,
})

const event = (sequence: number, type: JobEvent['type']): JobEvent => ({
  sequence,
  jobId: 'workspace-job',
  type,
  message: type === 'completed' ? 'Job completed successfully' : 'Applying workspace',
  progress: type === 'completed' ? 100 : 55,
  createdAt: '2026-07-27T12:00:01.000Z',
})

test('treats cancellation as terminal and refreshes the final record', async () => {
  const scope = effectScope()
  const jobProp = ref<JobRecord | null>(job('running'))
  let listener: ((event: MessageEvent<string>) => void) | null = null
  let closes = 0
  const finished: JobRecord[] = []
  const state = scope.run(() =>
    useJobLogStream(
      () => jobProp.value,
      (record) => finished.push(record),
      () => ({
        close: () => { closes += 1 },
        onJob: (nextListener) => { listener = nextListener },
      }),
      async () => ({
        ...job('cancelled'),
        finishedAt: '2026-07-27T12:00:02.000Z',
      }),
    ),
  )
  if (!state || !listener) throw new Error('Unable to create cancellation log scope')

  ;(listener as (event: MessageEvent<string>) => void)({
    data: JSON.stringify(event(1, 'cancelled')),
  } as MessageEvent<string>)
  await Promise.resolve()
  await nextTick()

  expect(state.currentJob.value?.status).toBe('cancelled')
  expect(finished[0]?.status).toBe('cancelled')
  expect(closes).toBe(1)

  scope.stop()
})

test('terminal parent refresh preserves logs and does not reconnect to the same job', async () => {
  const scope = effectScope()
  const jobProp = ref<JobRecord | null>(job('queued'))
  const listeners: Array<(event: MessageEvent<string>) => void> = []
  let connections = 0
  let closes = 0
  const finished: JobRecord[] = []

  const state = scope.run(() =>
    useJobLogStream(
      () => jobProp.value,
      (record) => {
        finished.push(record)
        jobProp.value = { ...record }
      },
      () => {
        connections += 1
        return {
          close: () => {
            closes += 1
          },
          onJob: (listener) => listeners.push(listener),
        }
      },
      async () => job('succeeded'),
    ),
  )
  if (!state) throw new Error('Unable to create job log scope')

  listeners[0]?.({ data: JSON.stringify(event(1, 'progress')) } as MessageEvent<string>)
  listeners[0]?.({ data: JSON.stringify(event(2, 'completed')) } as MessageEvent<string>)
  await Promise.resolve()
  await nextTick()

  expect(state.events.value.map((item) => item.sequence)).toEqual([1, 2])
  expect(state.currentJob.value?.status).toBe('succeeded')
  expect(finished).toHaveLength(1)
  expect(connections).toBe(1)
  expect(closes).toBe(1)

  scope.stop()
})

test('a different job replaces logs and opens one new connection', async () => {
  const scope = effectScope()
  const jobProp = ref<JobRecord | null>(job('queued'))
  let connections = 0
  const listeners: Array<(event: MessageEvent<string>) => void> = []
  const state = scope.run(() =>
    useJobLogStream(
      () => jobProp.value,
      () => {},
      () => {
        connections += 1
        return {
          close: () => {},
          onJob: (listener) => listeners.push(listener),
        }
      },
      async () => job('succeeded'),
    ),
  )
  if (!state) throw new Error('Unable to create job log scope')

  listeners[0]?.({ data: JSON.stringify(event(1, 'progress')) } as MessageEvent<string>)
  jobProp.value = { ...job('queued'), id: 'next-job' }
  await nextTick()

  expect(state.events.value).toEqual([])
  expect(connections).toBe(2)

  scope.stop()
})
