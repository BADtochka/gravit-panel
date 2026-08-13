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
  let listener: ((events: JobEvent[]) => void) | null = null
  let closes = 0
  const finished: JobRecord[] = []
  const state = scope.run(() =>
    useJobLogStream(
      () => jobProp.value,
      (record) => finished.push(record),
      () => ({
        close: () => { closes += 1 },
        onEvents: (nextListener) => { listener = nextListener },
        onState: () => {},
      }),
      async () => ({
        ...job('cancelled'),
        finishedAt: '2026-07-27T12:00:02.000Z',
      }),
    ),
  )
  if (!state || !listener) throw new Error('Unable to create cancellation log scope')

  ;(listener as (events: JobEvent[]) => void)([event(1, 'cancelled')])
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
  const listeners: Array<(events: JobEvent[]) => void> = []
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
          onEvents: (listener) => listeners.push(listener),
          onState: () => {},
        }
      },
      async () => job('succeeded'),
    ),
  )
  if (!state) throw new Error('Unable to create job log scope')

  listeners[0]?.([event(1, 'progress')])
  listeners[0]?.([event(2, 'completed')])
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
  const listeners: Array<(events: JobEvent[]) => void> = []
  const state = scope.run(() =>
    useJobLogStream(
      () => jobProp.value,
      () => {},
      () => {
        connections += 1
        return {
          close: () => {},
          onEvents: (listener) => listeners.push(listener),
          onState: () => {},
        }
      },
      async () => job('succeeded'),
    ),
  )
  if (!state) throw new Error('Unable to create job log scope')

  listeners[0]?.([event(1, 'progress')])
  jobProp.value = { ...job('queued'), id: 'next-job' }
  await nextTick()

  expect(state.events.value).toEqual([])
  expect(connections).toBe(2)

  scope.stop()
})

test('polling reports a fast failure when the socket delivers no events', async () => {
  const scope = effectScope()
  const jobProp = ref<JobRecord | null>(job('running'))
  const finished: JobRecord[] = []
  const failed = {
    ...job('failed'),
    error: 'Server agent artifact is missing',
    finishedAt: '2026-07-27T12:00:02.000Z',
  }
  let stateListener: ((state: 'connecting' | 'live' | 'reconnecting' | 'closed') => void) | null = null
  const state = scope.run(() => useJobLogStream(
    () => jobProp.value,
    (record) => finished.push(record),
    () => ({
      close: () => {},
      onEvents: () => {},
      onState: (listener) => { stateListener = listener },
    }),
    async () => failed,
    1,
  ))
  if (!state) throw new Error('Unable to create polling log scope')

  ;(stateListener as ((state: 'reconnecting') => void) | null)?.('reconnecting')
  await Bun.sleep(10)
  await nextTick()

  expect(state.currentJob.value).toMatchObject({ status: 'failed', error: failed.error })
  expect(state.events.value).toHaveLength(1)
  expect(state.events.value[0]).toMatchObject({ type: 'failed', message: failed.error })
  expect(finished).toHaveLength(1)

  scope.stop()
})
