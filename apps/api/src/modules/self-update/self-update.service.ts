import type { PanelUpdateDeployResult, PanelUpdateStatus } from '@gravit-panel/shared'

interface SelfUpdateConfig {
  currentRevision?: string
  repository: string
  githubToken?: string
  coolifyApiUrl?: string
  coolifyApiToken?: string
  coolifyApplicationUuid?: string
}

interface ReleaseResponse {
  tag_name?: string
}

interface CoolifyDeployResponse {
  deployments?: Array<{
    message?: string
    deployment_uuid?: string
    resource_uuid?: string
  }>
}

type Fetcher = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>

const revisionPattern = /^[a-f0-9]{40}$/i
const cacheLifetimeMs = 5 * 60_000
const deployCooldownMs = 60_000

export class SelfUpdateUnavailableError extends Error {}
export class SelfUpdateConflictError extends Error {}

export class SelfUpdateService {
  private latestCache: { revision: string | null; expiresAt: number } | null = null
  private lastDeployAt = 0

  constructor(
    private readonly config: SelfUpdateConfig,
    private readonly fetcher: Fetcher = fetch,
  ) {}

  async status(force = false): Promise<PanelUpdateStatus> {
    const currentRevision = this.revision(this.config.currentRevision)
    const configured = this.deployConfigured()
    try {
      const latestRevision = await this.latestRevision(force)
      return {
        configured,
        deployEnabled: configured && Boolean(currentRevision && latestRevision),
        currentRevision,
        latestRevision,
        updateAvailable:
          currentRevision && latestRevision ? currentRevision !== latestRevision : null,
        checkedAt: new Date().toISOString(),
        message: currentRevision
          ? latestRevision ? null : 'Latest published revision is unavailable.'
          : 'Running image does not expose its source revision.',
      }
    } catch (error) {
      return {
        configured,
        deployEnabled: false,
        currentRevision,
        latestRevision: null,
        updateAvailable: null,
        checkedAt: new Date().toISOString(),
        message: error instanceof Error ? error.message : String(error),
      }
    }
  }

  async deploy(): Promise<PanelUpdateDeployResult> {
    if (!this.deployConfigured()) {
      throw new SelfUpdateUnavailableError('Coolify self-update is not configured.')
    }
    if (Date.now() - this.lastDeployAt < deployCooldownMs) {
      throw new SelfUpdateConflictError('A panel deployment was requested recently.')
    }
    const endpoint = this.coolifyEndpoint()
    const response = await this.fetcher(`${endpoint}/deploy`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${this.config.coolifyApiToken}`,
        'content-type': 'application/json',
        accept: 'application/json',
      },
      body: JSON.stringify({ uuid: this.config.coolifyApplicationUuid, force: true }),
    })
    const payload = (await response.json().catch(() => null)) as CoolifyDeployResponse | null
    if (!response.ok) {
      throw new Error(`Coolify rejected panel deployment with HTTP ${response.status}.`)
    }
    this.lastDeployAt = Date.now()
    const deployment = payload?.deployments?.find(
      (item) => item.resource_uuid === this.config.coolifyApplicationUuid,
    ) ?? payload?.deployments?.[0]
    return {
      accepted: true,
      deploymentUuid: deployment?.deployment_uuid ?? null,
      message: deployment?.message ?? 'Panel deployment queued.',
    }
  }

  private async latestRevision(force = false) {
    if (!force && this.latestCache && this.latestCache.expiresAt > Date.now()) {
      return this.latestCache.revision
    }
    const response = await this.fetcher(
        `https://api.github.com/repos/${this.config.repository}/releases/latest`,
      {
        headers: {
          accept: 'application/vnd.github+json',
          'user-agent': 'GravitPanel/0.1 self-update',
          ...(this.config.githubToken
            ? { authorization: `Bearer ${this.config.githubToken}` }
            : {}),
        },
      },
    )
    if (!response.ok) {
      throw new Error(`Unable to check published panel revision (HTTP ${response.status}).`)
    }
    const payload = (await response.json()) as ReleaseResponse
    const revision = this.revision(payload.tag_name?.match(/[a-f0-9]{40}$/i)?.[0])
    this.latestCache = { revision, expiresAt: Date.now() + cacheLifetimeMs }
    return revision
  }

  private deployConfigured() {
    return Boolean(
      this.config.coolifyApiUrl &&
      this.config.coolifyApiToken &&
      this.config.coolifyApplicationUuid,
    )
  }

  private coolifyEndpoint() {
    const url = new URL(this.config.coolifyApiUrl!)
    if (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(url.hostname))) {
      throw new SelfUpdateUnavailableError('COOLIFY_API_URL must use HTTPS.')
    }
    const basePath = url.pathname.replace(/\/+$/, '')
    url.pathname = basePath.endsWith('/api/v1') ? basePath : `${basePath}/api/v1`
    url.search = ''
    url.hash = ''
    return url.toString().replace(/\/$/, '')
  }

  private revision(value: string | undefined) {
    const revision = value?.trim() ?? ''
    return revisionPattern.test(revision) ? revision.toLowerCase() : null
  }
}
