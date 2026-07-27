import type {
  GravitInstallation,
  LaunchServerCommandResult,
  LaunchServerInspectionCommand,
} from '@gravit-panel/shared'
import type { RemoteControlCredential } from './remote-control.store'

export const remoteControlSource = {
  repository: 'https://github.com/GravitLauncher/LauncherModules',
  revision: '0fcdfade1960c353a9f0bbb2f92055f05e22867d',
  file: 'RemoteControl_module/src/main/java/pro/gravit/launchermodules/remotecontrol/RemoteControlWebSeverlet.java',
} as const

interface RemoteControlResponse {
  error?: string
  data?: {
    success: boolean
    exception: string | null
    lines: Array<{
      level: string
      message: string
      exception: string | null
    }> | null
  }
}

type Fetcher = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>

export class RemoteControlHttpService {
  constructor(private readonly fetcher: Fetcher = fetch) {}

  async execute(
    installation: GravitInstallation,
    credential: Pick<RemoteControlCredential, 'endpoint' | 'token'>,
    command: LaunchServerInspectionCommand,
  ): Promise<LaunchServerCommandResult> {
    const url = this.commandUrl(credential.endpoint, credential.token, command)
    const startedAt = new Date().toISOString()
    let response: Response
    try {
      response = await this.fetcher(url, {
        method: 'POST',
        signal: AbortSignal.timeout(30_000),
      })
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error)
      throw new Error(
        `RemoteControl endpoint ${url.origin} is unreachable. Ensure its nginx/HTTP proxy is running. ${reason}`,
      )
    }
    let body: RemoteControlResponse
    try {
      body = (await response.json()) as RemoteControlResponse
    } catch {
      throw new Error(
        `RemoteControl endpoint ${url.origin} returned a non-JSON HTTP ${response.status} response`,
      )
    }

    if (!response.ok || body.error) {
      throw new Error(body.error ?? `RemoteControl returned HTTP ${response.status}`)
    }
    if (!body.data?.success) {
      throw new Error(body.data?.exception ?? 'RemoteControl command failed')
    }

    const lines = (body.data.lines ?? []).map((line) => {
      const suffix = line.exception ? ` (${line.exception})` : ''
      return `[${line.level}] ${line.message}${suffix}`
    })

    return {
      installationId: installation.id,
      command,
      transport: 'remote-control',
      lines,
      startedAt,
      finishedAt: new Date().toISOString(),
      source: remoteControlSource,
    }
  }

  validateEndpoint(endpoint: string) {
    const url = new URL(endpoint)
    if (!['http:', 'https:'].includes(url.protocol)) {
      throw new Error('RemoteControl endpoint must use http or https')
    }
    if (url.username || url.password || url.search || url.hash) {
      throw new Error('RemoteControl endpoint must not contain credentials, query, or fragment')
    }
    return url.origin
  }

  private commandUrl(
    endpoint: string,
    token: string,
    command: LaunchServerInspectionCommand,
  ) {
    const origin = this.validateEndpoint(endpoint)
    const url = new URL('/webapi/remotecontrol/command', origin)
    url.searchParams.set('token', token)
    url.searchParams.set('command', command)
    url.searchParams.set('log', 'true')
    return url
  }
}
