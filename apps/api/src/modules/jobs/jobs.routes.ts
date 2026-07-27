import { Elysia, t } from 'elysia'
import { jobsEventHub, jobsRunner, jobsStore } from './jobs.runtime'

const parseSequence = (value: string | undefined) => {
  const sequence = Number(value ?? 0)
  return Number.isSafeInteger(sequence) && sequence >= 0 ? sequence : 0
}

export const jobsRoutes = new Elysia({ prefix: '/jobs' })
  .get(
    '/',
    ({ query }) => ({
      items: jobsStore.list(query.limit),
      runningIds: jobsRunner.runningIds(),
    }),
    {
      query: t.Object({
        limit: t.Optional(t.Numeric({ minimum: 1, maximum: 100, default: 50 })),
      }),
    },
  )
  .post('/demo', ({ set }) => {
    set.status = 202
    return jobsRunner.createDemoJob()
  })
  .get(
    '/active',
    ({ query }) => ({
      job: jobsStore
        .listByStatuses(['queued', 'running'])
        .find((job) => job.input.installationId === query.installationId) ?? null,
    }),
    {
      query: t.Object({
        installationId: t.String({ format: 'uuid' }),
      }),
    },
  )
  .post('/:id/cancel', ({ params, set }) => {
    const existing = jobsStore.get(params.id)
    if (!existing) {
      set.status = 404
      return { message: 'Job not found' }
    }
    if (existing.status !== 'queued' && existing.status !== 'running') {
      set.status = 409
      return { message: 'Only queued or running jobs can be cancelled.', job: existing }
    }
    set.status = 202
    return jobsRunner.cancel(params.id)
  })
  .get('/:id', ({ params, set }) => {
    const job = jobsStore.get(params.id)
    if (job) return job

    set.status = 404
    return { message: 'Job not found' }
  })
  .get('/:id/events', ({ params, headers, set }) => {
    const job = jobsStore.get(params.id)
    if (!job) {
      set.status = 404
      return { message: 'Job not found' }
    }

    const afterSequence = parseSequence(headers['last-event-id'])
    return jobsEventHub.stream(
      params.id,
      () => jobsStore.listEvents(params.id, afterSequence),
      () => {
        const current = jobsStore.get(params.id)
        return (
          current?.status === 'succeeded' ||
          current?.status === 'failed' ||
          current?.status === 'cancelled'
        )
      },
    )
  })
