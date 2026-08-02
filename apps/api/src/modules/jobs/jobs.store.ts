import type { JobEvent, JobEventType, JobRecord, JobStatus, JobType } from '@gravit-panel/shared'
import type { Database } from 'bun:sqlite'

interface JobRow {
  id: string
  type: JobType
  status: JobStatus
  progress: number
  input_json: string
  result_json: string | null
  error: string | null
  created_at: string
  started_at: string | null
  finished_at: string | null
}

interface JobEventRow {
  sequence: number
  job_id: string
  type: JobEventType
  message: string
  progress: number | null
  created_at: string
}

const parseObject = (value: string | null): Record<string, unknown> | null =>
  value === null ? null : (JSON.parse(value) as Record<string, unknown>)

const toJob = (row: JobRow): JobRecord => ({
  id: row.id,
  type: row.type,
  status: row.status,
  progress: row.progress,
  input: parseObject(row.input_json) ?? {},
  result: parseObject(row.result_json),
  error: row.error,
  createdAt: row.created_at,
  startedAt: row.started_at,
  finishedAt: row.finished_at,
})

const toEvent = (row: JobEventRow): JobEvent => ({
  sequence: row.sequence,
  jobId: row.job_id,
  type: row.type,
  message: row.message,
  progress: row.progress,
  createdAt: row.created_at,
})

export class JobsStore {
  constructor(private readonly db: Database) {}

  create(type: JobType, input: Record<string, unknown>): JobRecord {
    const job: JobRecord = {
      id: crypto.randomUUID(),
      type,
      status: 'queued',
      progress: 0,
      input,
      result: null,
      error: null,
      createdAt: new Date().toISOString(),
      startedAt: null,
      finishedAt: null,
    }

    this.db
      .query(`
        INSERT INTO jobs (
          id, type, status, progress, input_json, result_json, error,
          created_at, started_at, finished_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `)
      .run(
        job.id,
        job.type,
        job.status,
        job.progress,
        JSON.stringify(job.input),
        null,
        null,
        job.createdAt,
        null,
        null,
      )

    return job
  }

  get(id: string): JobRecord | null {
    const row = this.db.query<JobRow, [string]>('SELECT * FROM jobs WHERE id = ?').get(id)
    return row ? toJob(row) : null
  }

  list(limit = 50): JobRecord[] {
    return this.db
      .query<JobRow, [number]>('SELECT * FROM jobs ORDER BY created_at DESC LIMIT ?')
      .all(limit)
      .map(toJob)
  }

  listByStatuses(statuses: JobStatus[]): JobRecord[] {
    if (statuses.length === 0) return []

    const placeholders = statuses.map(() => '?').join(', ')
    return this.db
      .query<JobRow, JobStatus[]>(`SELECT * FROM jobs WHERE status IN (${placeholders})`)
      .all(...statuses)
      .map(toJob)
  }

  update(
    id: string,
    values: Partial<
      Pick<JobRecord, 'status' | 'progress' | 'result' | 'error' | 'startedAt' | 'finishedAt'>
    >,
  ): JobRecord {
    const current = this.get(id)
    if (!current) throw new Error(`Job ${id} does not exist`)

    const next = { ...current, ...values }
    this.db
      .query(`
        UPDATE jobs
        SET status = ?, progress = ?, result_json = ?, error = ?, started_at = ?, finished_at = ?
        WHERE id = ?
      `)
      .run(
        next.status,
        next.progress,
        next.result === null ? null : JSON.stringify(next.result),
        next.error,
        next.startedAt,
        next.finishedAt,
        id,
      )

    return next
  }

  appendEvent(
    jobId: string,
    type: JobEventType,
    message: string,
    progress: number | null = null,
  ): JobEvent {
    const createdAt = new Date().toISOString()
    const result = this.db
      .query(`
        INSERT INTO job_events (job_id, type, message, progress, created_at)
        VALUES (?, ?, ?, ?, ?)
      `)
      .run(jobId, type, message, progress, createdAt)

    return {
      sequence: Number(result.lastInsertRowid),
      jobId,
      type,
      message,
      progress,
      createdAt,
    }
  }

  listEvents(jobId: string, afterSequence = 0): JobEvent[] {
    return this.db
      .query<JobEventRow, [string, number]>(`
        SELECT * FROM job_events
        WHERE job_id = ? AND sequence > ?
        ORDER BY sequence ASC
      `)
      .all(jobId, afterSequence)
      .map(toEvent)
  }

  listRecentEvents(jobId: string, limit = 1000): JobEvent[] {
    return this.db
      .query<JobEventRow, [string, number]>(`
        SELECT sequence, job_id, type, message, progress, created_at
        FROM (
          SELECT sequence, job_id, type, message, progress, created_at
          FROM job_events
          WHERE job_id = ?
          ORDER BY sequence DESC
          LIMIT ?
        )
        ORDER BY sequence ASC
      `)
      .all(jobId, limit)
      .map(toEvent)
  }
}
