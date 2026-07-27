import { describe, expect, test } from 'bun:test'
import { Database } from 'bun:sqlite'
import { schema } from '../../db/schema'
import { JobsEventHub } from './jobs.events'
import { JobsRunner } from './jobs.runner'
import { JobsStore } from './jobs.store'

const waitFor = async (predicate: () => boolean) => {
  const deadline = Date.now() + 1_000
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('Timed out waiting for job state')
    await Bun.sleep(5)
  }
}

describe('JobsRunner cancellation', () => {
  test('aborts a running task and persists a dedicated terminal state', async () => {
    const database = new Database(':memory:')
    database.exec(schema)
    const store = new JobsStore(database)
    const runner = new JobsRunner(store, new JobsEventHub())
    const job = runner.create(
      'demo.noop',
      { installationId: crypto.randomUUID() },
      'Queued',
      async ({ signal }) => {
        await new Promise<void>((resolve, reject) => {
          signal.addEventListener('abort', () => reject(signal.reason), { once: true })
          if (signal.aborted) reject(signal.reason)
        })
        return { unreachable: true }
      },
    )
    await waitFor(() => store.get(job.id)?.status === 'running')

    expect(runner.cancel(job.id)?.status).toBe('running')
    await waitFor(() => store.get(job.id)?.status === 'cancelled')

    const cancelled = store.get(job.id)
    expect(cancelled?.status).toBe('cancelled')
    expect(cancelled?.error).toBeNull()
    expect(cancelled?.finishedAt).not.toBeNull()
    expect(store.listEvents(job.id).map((event) => event.type)).toContain('cancelled')
    expect(runner.runningIds()).not.toContain(job.id)
  })

  test('does not mutate an already completed job', async () => {
    const database = new Database(':memory:')
    database.exec(schema)
    const store = new JobsStore(database)
    const runner = new JobsRunner(store, new JobsEventHub())
    const job = runner.create('demo.noop', {}, 'Queued', async () => ({ done: true }))
    await waitFor(() => store.get(job.id)?.status === 'succeeded')

    expect(runner.cancel(job.id)?.status).toBe('succeeded')
    expect(store.listEvents(job.id).at(-1)?.type).toBe('completed')
  })
})
