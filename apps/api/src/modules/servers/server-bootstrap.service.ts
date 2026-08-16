import type {
  GravitInstallation,
  MinecraftLoader,
  ProfileServerBinding,
  ServerBootstrapIssueResult,
} from '@gravit-panel/shared'
import { createHash } from 'node:crypto'
import { Buffer } from 'node:buffer'
import {
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { env } from '../../core/env'
import type { ClientBuildService } from '../clients/client-build.service'
import { resolveClientCompatibility } from '../clients/compatibility.service'
import type { ControlFileService } from '../gravit/control-file.service'
import type { JobTaskContext } from '../jobs/jobs.runner'
import type { ServerBindingsStore } from './server-bindings.store'
import type { ServerBootstrapStore } from './server-bootstrap.store'

const wrapperArtifacts = {
  serverWrapper: {
    url: 'https://github.com/GravitLauncher/Launcher/releases/download/v5.7.9/ServerWrapper.jar',
    sha256: '7dc5bc4fe1ef84c37468a48f320a2065dc1aad9ae941a4d29770c09aef500ef6',
  },
  inline: {
    url: 'https://github.com/GravitLauncher/Launcher/releases/download/v5.7.9/ServerWrapperInline.jar',
    sha256: '3b3522e4d46f3804bed6d4078e41ea90557da14db8562b97a10c4fd0be301d7b',
  },
} as const

const temurinJre21 = {
  version: '21.0.12+8',
  x64: {
    url:
      'https://github.com/adoptium/temurin21-binaries/releases/download/' +
      'jdk-21.0.12%2B8/OpenJDK21U-jre_x64_linux_hotspot_21.0.12_8.tar.gz',
    sha256: '8a379a67c91a3ae61ffb33d46e0a40c7ba35e70713c4db31cfca30492f792eff',
  },
  aarch64: {
    url:
      'https://github.com/adoptium/temurin21-binaries/releases/download/' +
      'jdk-21.0.12%2B8/OpenJDK21U-jre_aarch64_linux_hotspot_21.0.12_8.tar.gz',
    sha256: '5f9c96b656827b9d14ebeda7739e25be554fa6d25669b03847c1df6e869c0679',
  },
} as const

const fabricInstaller = {
  version: '1.1.1',
  url:
    'https://maven.fabricmc.net/net/fabricmc/fabric-installer/1.1.1/' +
    'fabric-installer-1.1.1.jar',
  sha256: '2487a69dd6f9d9c2605265a7142d77c26ab62edc620e6bcf810d581d2ee31b79',
} as const

interface BootstrapConfig {
  eulaAcceptedAt: string
  profileUuid: string
  minecraftVersion: string
  loader: Exclude<MinecraftLoader, 'QUILT'>
  loaderVersion: string | null
  authlibArtifact: string
  coreFile: string
  coreInstall: 'vanilla' | 'fabric' | 'forge' | 'neoforge'
  hasServerPack: boolean
  launchServerAddress: string
  binding: ProfileServerBinding
}

const sha256 = (bytes: Uint8Array) =>
  createHash('sha256').update(bytes).digest('hex')
const sha1 = (bytes: Uint8Array) =>
  createHash('sha1').update(bytes).digest('hex')
const shellQuote = (value: string) => `'${value.replaceAll("'", "'\"'\"'")}'`

const cyrillicTransliteration: Record<string, string> = {
  а: 'a', б: 'b', в: 'v', г: 'g', д: 'd', е: 'e', ё: 'yo', ж: 'zh', з: 'z',
  и: 'i', й: 'y', к: 'k', л: 'l', м: 'm', н: 'n', о: 'o', п: 'p', р: 'r',
  с: 's', т: 't', у: 'u', ф: 'f', х: 'kh', ц: 'ts', ч: 'ch', ш: 'sh',
  щ: 'shch', ъ: '', ы: 'i', ь: '', э: 'e', ю: 'yu', я: 'ya',
}

export const serverServiceSlug = (name: string, bindingId: string) => {
  const transliterated = [...name.toLocaleLowerCase('ru-RU')]
    .map((character) => cyrillicTransliteration[character] ?? character)
    .join('')
  const slug = transliterated
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64)
    .replace(/-+$/g, '')
  return slug || `server-${bindingId.slice(0, 8).toLowerCase()}`
}

const fetchBytes = async (url: string, maximumBytes = 512 * 1024 * 1024) => {
  const response = await fetch(url, {
    redirect: 'follow',
    signal: AbortSignal.timeout(5 * 60_000),
    headers: { 'User-Agent': 'GravitPanel/0.1 server-bootstrap' },
  })
  if (!response.ok) throw new Error(`Artifact request failed with HTTP ${response.status}: ${url}`)
  const declared = Number(response.headers.get('content-length') ?? 0)
  if (declared > maximumBytes) throw new Error(`Artifact exceeds size limit: ${url}`)
  const bytes = new Uint8Array(await response.arrayBuffer())
  if (!bytes.length || bytes.length > maximumBytes) {
    throw new Error(`Artifact has an invalid size: ${url}`)
  }
  return bytes
}

const fetchSha256Verified = async (url: string, expected: string) => {
  const bytes = await fetchBytes(url)
  const actual = sha256(bytes)
  if (actual !== expected.toLowerCase()) {
    throw new Error(`Artifact checksum mismatch for ${url}`)
  }
  return bytes
}

export const launchServerWebSocketAddress = (publicUrl: string) => {
  const url = new URL(publicUrl)
  if (url.protocol === 'https:') url.protocol = 'wss:'
  else if (url.protocol === 'http:') url.protocol = 'ws:'
  else if (url.protocol !== 'wss:' && url.protocol !== 'ws:') {
    throw new Error('LAUNCHSERVER_PUBLIC_URL must use HTTP, HTTPS, WS, or WSS')
  }
  const basePath = url.pathname.replace(/\/+$/, '')
  url.pathname = basePath.endsWith('/api') ? basePath : `${basePath}/api`
  url.search = ''
  url.hash = ''
  return url.toString()
}

export class ServerBootstrapService {
  constructor(
    private readonly drafts: ServerBootstrapStore,
    private readonly bindings: ServerBindingsStore,
    private readonly clients: Pick<ClientBuildService, 'getProfile'>,
    private readonly control: Pick<ControlFileService, 'createServerToken'>,
    private readonly publicUrl: string | undefined,
    private readonly launchServerPublicUrl: string,
    private readonly agentArtifactsDir = env.SERVER_AGENT_ARTIFACTS_DIR,
  ) {}

  async agentArtifactsReadiness() {
    const required = ['gravit-agent-amd64', 'gravit-agent-arm64']
    for (const filename of required) {
      const path = join(this.agentArtifactsDir, filename)
      try {
        if (!(await stat(path)).isFile()) {
          return { ready: false, message: `Server agent artifact is not a file: ${path}` }
        }
      } catch (error) {
        const reason = (error as NodeJS.ErrnoException).code === 'ENOENT'
          ? 'is missing'
          : `cannot be accessed: ${error instanceof Error ? error.message : String(error)}`
        return { ready: false, message: `Server agent artifact ${reason}: ${path}` }
      }
    }
    return { ready: true, message: null }
  }

  list(bindingId: string) {
    return { items: this.drafts.list(bindingId) }
  }

  createDraft(installation: GravitInstallation, bindingId: string) {
    const binding = this.requireBinding(installation, bindingId)
    if (!binding.eulaAcceptedAt) {
      throw new Error('Minecraft EULA must be accepted before preparing the first installation')
    }
    return this.drafts.create({
      bindingId,
      installationId: installation.id,
      profileName: binding.profileName,
      serverName: binding.name,
      config: { eulaAcceptedAt: binding.eulaAcceptedAt },
    })
  }

  acceptEula(installation: GravitInstallation, bindingId: string) {
    this.requireBinding(installation, bindingId)
    return this.bindings.acceptEula(bindingId)
  }

  async prepare(
    installation: GravitInstallation,
    draftId: string,
    context: JobTaskContext,
  ) {
    const draft = this.drafts.internal(draftId)
    if (!draft || draft.installation_id !== installation.id || draft.status !== 'preparing') {
      throw new Error('Bootstrap draft is not available for preparation')
    }
    try {
      const binding = this.requireBinding(installation, draft.binding_id)
      const profile = await this.clients.getProfile(installation, binding.profileName)
      if (!profile.uuid || !profile.minecraftVersion || !profile.loader) {
        throw new Error('Profile compatibility metadata is incomplete')
      }
      if (profile.loader === 'QUILT') throw new Error('Quilt bootstrap is not supported')
      if (profile.loader !== 'VANILLA' && !profile.loaderVersion) {
        throw new Error('Exact loader version cannot be derived from the profile')
      }
      if (!binding.authId || !binding.xms || !binding.xmx) {
        throw new Error('Server binding bootstrap settings are incomplete')
      }
      const compatibility = resolveClientCompatibility(profile.minecraftVersion)
      const launchServerAddress = launchServerWebSocketAddress(this.launchServerPublicUrl)
      const draftConfig = JSON.parse(draft.config_json) as { eulaAcceptedAt?: unknown }
      const config: BootstrapConfig = {
        eulaAcceptedAt:
          typeof draftConfig.eulaAcceptedAt === 'string'
            ? draftConfig.eulaAcceptedAt
            : new Date().toISOString(),
        profileUuid: profile.uuid,
        minecraftVersion: profile.minecraftVersion,
        loader: profile.loader,
        loaderVersion: profile.loaderVersion,
        authlibArtifact: compatibility.authlibArtifact,
        coreFile: profile.loader === 'VANILLA' ? 'server.jar' : 'core-installer.jar',
        coreInstall: profile.loader.toLowerCase() as BootstrapConfig['coreInstall'],
        hasServerPack: false,
        launchServerAddress,
        binding,
      }

      context.progress(10, 'Resolving verified ServerWrapper and core artifacts')
      const root = join(installation.path, 'server-bootstrap', draftId)
      const cacheRoot = join(installation.path, 'server-bootstrap', 'cache')
      const staging = await mkdtemp(join(tmpdir(), 'gravit-server-bootstrap-'))
      await Promise.all([
        mkdir(root, { recursive: true }),
        mkdir(cacheRoot, { recursive: true }),
      ])
      try {
        const [wrapper, inline, core] = await Promise.all([
          fetchSha256Verified(
            wrapperArtifacts.serverWrapper.url,
            wrapperArtifacts.serverWrapper.sha256,
          ),
          fetchSha256Verified(wrapperArtifacts.inline.url, wrapperArtifacts.inline.sha256),
          this.resolveCore(config),
        ])
        await Promise.all([
          writeFile(join(staging, 'ServerWrapper.jar'), wrapper),
          writeFile(join(staging, 'ServerWrapperInline.jar'), inline),
          writeFile(join(staging, config.coreFile), core.bytes),
        ])
        const agentPaths = [
          join(this.agentArtifactsDir, 'gravit-agent-amd64'),
          join(this.agentArtifactsDir, 'gravit-agent-arm64'),
        ]
        const [agentAmd64, agentArm64] = await Promise.all(agentPaths.map(async (path) => {
          try {
            return await readFile(path)
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
              throw new Error(`Server agent artifact is missing from the API image: ${path}. Pull and redeploy the current gravit-panel-api image.`)
            }
            throw error
          }
        }))
        await Promise.all([
          writeFile(join(staging, 'gravit-agent-amd64'), agentAmd64),
          writeFile(join(staging, 'gravit-agent-arm64'), agentArm64),
        ])
        const authlibPath = join(
          installation.path,
          'launcher',
          'config',
          'MirrorHelper',
          'workspace',
          'authlib',
          compatibility.authlibArtifact,
        )
        if (!(await stat(authlibPath)).isFile()) {
          throw new Error(`${compatibility.authlibArtifact} is absent from MirrorHelper workspace`)
        }
        await copyFile(authlibPath, join(staging, 'LauncherAuthlib.jar'))
        await writeFile(
          join(staging, 'bootstrap-manifest.json'),
          `${JSON.stringify({
            launcherVersion: '5.7.9',
            javaRuntime: `Temurin ${temurinJre21.version}`,
            minecraftVersion: config.minecraftVersion,
            loader: config.loader,
            loaderVersion: config.loaderVersion,
            fabricInstaller:
              config.loader === 'FABRIC' ? fabricInstaller.version : null,
            coreSha256: sha256(core.bytes),
            authlibArtifact: config.authlibArtifact,
            serverPackId: null,
          }, null, 2)}\n`,
        )
        context.progress(45, 'Packing bootstrap payload')
        const bundlePath = join(root, 'bundle.tar.gz')
        await this.createTar(staging, bundlePath)
        const bundleSha256 = sha256(new Uint8Array(await readFile(bundlePath)))

        context.progress(60, 'Downloading pinned portable Java 21 runtimes')
        const [jreX64, jreAarch64] = await Promise.all([
          this.resolveJre('x64', cacheRoot),
          this.resolveJre('aarch64', cacheRoot),
        ])
        const ready = this.drafts.ready(draftId, {
          bundlePath,
          bundleSha256,
          jreX64Path: jreX64.path,
          jreX64Sha256: jreX64.sha256,
          jreAarch64Path: jreAarch64.path,
          jreAarch64Sha256: jreAarch64.sha256,
          config: config as unknown as Record<string, unknown>,
        })
        this.bindings.setState(draft.binding_id, 'ready')
        context.progress(95, 'Bootstrap bundles are ready for one-time issuance')
        return { draft: ready }
      } finally {
        await rm(staging, { recursive: true, force: true })
      }
    } catch (error) {
      this.drafts.fail(draftId, error instanceof Error ? error.message : String(error))
      this.bindings.setState(draft.binding_id, 'failed')
      throw error
    }
  }

  async issue(
    installation: GravitInstallation,
    draftId: string,
  ): Promise<ServerBootstrapIssueResult> {
    const publicUrl = this.requirePublicUrl()
    const row = this.drafts.internal(draftId)
    if (!row || row.installation_id !== installation.id) {
      throw new Error('Bootstrap draft not found')
    }
    const config = JSON.parse(row.config_json) as BootstrapConfig
    await this.assertDraftCurrent(installation, row, config)
    const issued = this.drafts.issue(draftId)
    return {
      draft: issued.draft,
      command: `${publicUrl.startsWith('https:')
        ? "curl --proto '=https' --tlsv1.2 -fsSL"
        : 'curl -fsSL'} ${shellQuote(`${publicUrl}/api/server-bootstrap/${issued.claim}`)} | sudo bash`,
      expiresAt: issued.expiresAt,
    }
  }

  loader(claim: string) {
    const publicUrl = this.requirePublicUrl()
    const startUrl = `${publicUrl}/api/server-bootstrap/${claim}/start`
    const curl = publicUrl.startsWith('https:')
      ? "curl --proto '=https' --tlsv1.2"
      : 'curl'
    return `#!/usr/bin/env bash
set -Eeuo pipefail
TMP="$(mktemp /tmp/gravit-bootstrap-stage2.XXXXXXXX)"
cleanup() { rm -f "$TMP"; }
trap cleanup EXIT
${curl} -fsSL -X POST ${shellQuote(startUrl)} -o "$TMP"
bash "$TMP"
`
  }

  async start(installation: GravitInstallation, claim: string) {
    const row = this.drafts.beginClaim(claim)
    if (!row || row.installation_id !== installation.id) return null
    try {
      const config = JSON.parse(row.config_json) as BootstrapConfig
      await this.assertDraftCurrent(installation, row, config)
      const token = await this.control.createServerToken(
        installation,
        config.profileUuid,
        config.binding.authId!,
      )
      return this.renderScript(row.id, config, token, claim)
    } catch (error) {
      throw error
    }
  }

  claimInstallationId(claim: string) {
    return this.drafts.claimInstallationId(claim)
  }

  artifact(claim: string, kind: 'bundle' | 'jre-x64' | 'jre-aarch64') {
    const row = this.drafts.artifactByClaim(claim)
    if (!row) return null
    const path =
      kind === 'bundle'
        ? row.bundle_path
        : kind === 'jre-x64'
          ? row.jre_x64_path
          : row.jre_aarch64_path
    const digest =
      kind === 'bundle'
        ? row.bundle_sha256
        : kind === 'jre-x64'
          ? row.jre_x64_sha256
          : row.jre_aarch64_sha256
    return path && digest ? { path, digest } : null
  }

  report(
    claim: string,
    status: 'installed' | 'failed',
    error?: string,
    updaterToken?: string,
  ) {
    const draft = this.drafts.reportClaim(claim, status, error)
    if (draft) {
      this.bindings.setState(draft.bindingId, status)
      if (status === 'installed' && updaterToken) {
        this.bindings.saveUpdaterToken(
          draft.bindingId,
          createHash('sha256').update(updaterToken).digest('hex'),
        )
      }
    }
    return draft
  }

  revoke(installation: GravitInstallation, draftId: string) {
    const row = this.drafts.internal(draftId)
    if (!row || row.installation_id !== installation.id) {
      throw new Error('Bootstrap draft not found')
    }
    return this.drafts.revoke(draftId)
  }

  updaterBinding(token: string) {
    if (!token) return null
    const binding = this.bindings.getByUpdaterTokenHash(
      createHash('sha256').update(token).digest('hex'),
    )
    return binding?.id ? this.bindings.touchUpdater(binding.id) : null
  }

  private requireBinding(installation: GravitInstallation, bindingId: string) {
    const binding = this.bindings.get(bindingId)
    if (!binding || binding.installationId !== installation.id || !binding.id) {
      throw new Error('Managed server binding not found')
    }
    return binding
  }

  private async assertDraftCurrent(
    installation: GravitInstallation,
    row: {
      binding_id: string
      profile_name: string
    },
    config: BootstrapConfig,
  ) {
    const profile = await this.clients.getProfile(installation, row.profile_name)
    const binding = this.requireBinding(installation, row.binding_id)
    const changed =
      profile.uuid !== config.profileUuid ||
      profile.minecraftVersion !== config.minecraftVersion ||
      profile.loader !== config.loader ||
      profile.loaderVersion !== config.loaderVersion ||
      binding.name !== config.binding.name ||
      binding.serverAddress !== config.binding.serverAddress ||
      binding.serverPort !== config.binding.serverPort ||
      binding.authId !== config.binding.authId ||
      binding.xms !== config.binding.xms ||
      binding.xmx !== config.binding.xmx ||
      JSON.stringify(binding.jvmArgs) !== JSON.stringify(config.binding.jvmArgs) ||
      JSON.stringify(binding.gameArgs) !== JSON.stringify(config.binding.gameArgs)
    if (!changed) return
    this.drafts.invalidateBinding(
      row.binding_id,
      'Profile or server binding changed; prepare a new bootstrap bundle',
    )
    throw new Error('Profile or server binding changed; prepare a new bootstrap bundle')
  }

  private requirePublicUrl() {
    if (!this.publicUrl) throw new Error('PANEL_PUBLIC_URL is required for server bootstrap')
    const url = new URL(this.publicUrl)
    if (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(url.hostname))) {
      throw new Error('PANEL_PUBLIC_URL must use HTTPS')
    }
    return this.publicUrl.replace(/\/+$/, '')
  }

  private async resolveCore(config: BootstrapConfig) {
    if (config.loader === 'VANILLA') return this.resolveVanilla(config.minecraftVersion)
    if (config.loader === 'FABRIC') return this.resolveFabricInstaller()
    const loaderVersion = config.loaderVersion!
    const artifactVersion =
      config.loader === 'FORGE'
        ? `${config.minecraftVersion}-${loaderVersion}`
        : loaderVersion
    const base =
      config.loader === 'FORGE'
        ? `https://maven.minecraftforge.net/net/minecraftforge/forge/${artifactVersion}/forge-${artifactVersion}-installer.jar`
        : `https://maven.neoforged.net/releases/net/neoforged/neoforge/${artifactVersion}/neoforge-${artifactVersion}-installer.jar`
    const checksumText = new TextDecoder().decode(await fetchBytes(`${base}.sha256`, 4096))
    const expected = checksumText.trim().split(/\s+/, 1)[0]?.toLowerCase()
    if (!expected || !/^[a-f0-9]{64}$/.test(expected)) {
      throw new Error(`${config.loader} installer returned an invalid checksum`)
    }
    return { bytes: await fetchSha256Verified(base, expected) }
  }

  private async resolveVanilla(version: string) {
    const manifest = JSON.parse(
      new TextDecoder().decode(
        await fetchBytes('https://piston-meta.mojang.com/mc/game/version_manifest_v2.json', 4 * 1024 * 1024),
      ),
    ) as { versions?: Array<{ id: string; url: string }> }
    const metadataUrl = manifest.versions?.find((item) => item.id === version)?.url
    if (!metadataUrl) throw new Error(`Mojang metadata does not contain Minecraft ${version}`)
    const metadata = JSON.parse(
      new TextDecoder().decode(await fetchBytes(metadataUrl, 4 * 1024 * 1024)),
    ) as { downloads?: { server?: { url?: string; sha1?: string } } }
    const server = metadata.downloads?.server
    if (!server?.url || !server.sha1) throw new Error(`Minecraft ${version} server is unavailable`)
    const bytes = await fetchBytes(server.url)
    if (sha1(bytes) !== server.sha1.toLowerCase()) {
      throw new Error('Mojang server checksum mismatch')
    }
    return { bytes }
  }

  private async resolveFabricInstaller() {
    return {
      bytes: await fetchSha256Verified(fabricInstaller.url, fabricInstaller.sha256),
    }
  }

  private async resolveJre(architecture: 'x64' | 'aarch64', root: string) {
    const pkg = temurinJre21[architecture]
    const path = join(root, `jre-${architecture}.tar.gz`)
    const existing = await readFile(path).catch(() => null)
    if (!existing || sha256(new Uint8Array(existing)) !== pkg.sha256) {
      await writeFile(path, await fetchSha256Verified(pkg.url, pkg.sha256))
    }
    return { path, sha256: pkg.sha256 }
  }

  private async createTar(source: string, target: string) {
    const process = Bun.spawn([
      'tar',
      '--sort=name',
      '--mtime=UTC 1970-01-01',
      '--owner=0',
      '--group=0',
      '--numeric-owner',
      '-czf',
      target,
      '-C',
      source,
      '.',
    ], { stdout: 'pipe', stderr: 'pipe' })
    if (await process.exited !== 0) {
      throw new Error(`Failed to build bootstrap bundle: ${await new Response(process.stderr).text()}`)
    }
  }

  private renderScript(
    draftId: string,
    config: BootstrapConfig,
    serverToken: string,
    claim: string,
  ) {
    const publicUrl = this.requirePublicUrl()
    const curl = publicUrl.startsWith('https:')
      ? "curl --proto '=https' --tlsv1.2"
      : 'curl'
    const internal = this.drafts.internal(draftId)!
    const artifactBase = `${publicUrl}/api/server-bootstrap/${claim}/artifacts`
    const reportUrl = `${publicUrl}/api/server-bootstrap/${claim}/report`
    const args = config.binding.gameArgs.map(shellQuote).join(' ')
    const jvmOptions = [
      `-Xms${config.binding.xms}`,
      `-Xmx${config.binding.xmx}`,
      ...config.binding.jvmArgs,
      '-Dlauncher.authlib.inlineClass=pro.gravit.launcher.server.ServerWrapperInlineInitializer',
      '-Dlauncher.useSlf4j=true',
    ].join(' ')
    const serviceName = `gravit-${serverServiceSlug(config.binding.name, config.binding.id!)}`
    const legacyServiceNames = [
      `gravit-${config.binding.id!.slice(0, 8)}`,
      `gravit-server-${config.binding.id!}`,
    ]
    const rconPort = 26_000 + (Number.parseInt(config.binding.id!.slice(0, 4), 16) % 10_000)
    const coreCommand =
      config.coreInstall === 'vanilla'
        ? 'install -m 0644 "$PAYLOAD/server.jar" "$WORKDIR/server.jar"'
        : config.coreInstall === 'fabric'
          ? `"$JAVA" -jar "$PAYLOAD/core-installer.jar" server -dir "$WORKDIR" -mcversion ${shellQuote(config.minecraftVersion)} -loader ${shellQuote(config.loaderVersion!)} -downloadMinecraft`
          : `"$JAVA" -jar "$PAYLOAD/core-installer.jar" --installServer "$WORKDIR"`
    const launchCommand =
      config.coreInstall === 'vanilla'
        ? `exec "$JAVA" -jar server.jar ${args || 'nogui'}`
        : config.coreInstall === 'fabric'
          ? `exec "$JAVA" -jar fabric-server-launch.jar ${args || 'nogui'}`
          : `export PATH="$WORKDIR/.gravit-panel/jre/bin:$PATH"\nexec ./run.sh ${args || 'nogui'}`
    return `#!/usr/bin/env bash
set -Eeuo pipefail
umask 077

REPORT_URL=${shellQuote(reportUrl)}
PAYLOAD=
BACKUP=
UNIT_TMP_DIR=
WORKDIR=
UPDATE=false
report_failure() {
  local code="$?"
  set +e
  [[ -z "$PAYLOAD" ]] || rm -rf "$PAYLOAD"
  [[ -z "$UNIT_TMP_DIR" ]] || rm -rf "$UNIT_TMP_DIR"
  if [[ -n "$WORKDIR" && -n "$BACKUP" && -f "$BACKUP" ]]; then
    tar -xzf "$BACKUP" -C "$WORKDIR" || true
    systemctl start ${serviceName}.service >/dev/null 2>&1 || true
  fi
  curl -fsS -X POST -H 'content-type: application/json' \\
    --data "{\\"status\\":\\"failed\\",\\"error\\":\\"installer exited with code $code\\"}" \\
    "$REPORT_URL" >/dev/null 2>&1 || true
}
trap report_failure EXIT

if [[ "$EUID" -ne 0 || -z "\${SUDO_USER:-}" || "$SUDO_USER" == root ]]; then
  echo "Run this command from a non-root account through sudo." >&2
  exit 1
fi
for command in curl tar sha256sum systemctl systemd-analyze install ln sed base64 head tr grep find nft ss; do
  command -v "$command" >/dev/null || { echo "Missing dependency: $command" >&2; exit 1; }
done

WORKDIR="$(pwd -P)"
SERVICE_USER="$SUDO_USER"
SERVICE_GROUP="$(id -gn "$SERVICE_USER")"
SERVICE_UID="$(id -u "$SERVICE_USER")"
SERVICE_GID="$(id -g "$SERVICE_USER")"
SERVICE_ROOT=/var/lib/gravit-panel/servers/${config.binding.id!}
if [[ "$SERVICE_UID" -eq 0 || ! -d "$WORKDIR" ]]; then
  echo "Unable to resolve the non-root service account or working directory." >&2
  exit 1
fi
MARKER="$WORKDIR/.gravit-panel-server"
if [[ -f "$MARKER" ]]; then
  grep -qx ${shellQuote(config.binding.id!)} "$MARKER" || {
    echo "This directory belongs to another bootstrap deployment." >&2
    exit 1
  }
  UPDATE=true
elif [[ -n "$(find "$WORKDIR" -mindepth 1 -maxdepth 1 -print -quit)" ]]; then
  echo "Initial installation requires an empty current directory." >&2
  exit 1
fi
printf '%s\\n' ${shellQuote(config.binding.id!)} > "$MARKER"

mkdir -p "$WORKDIR/.gravit-panel/download" "$WORKDIR/.gravit-panel/jre"
if [[ "$UPDATE" == true ]]; then
  for SERVER_SERVICE in ${[serviceName, ...legacyServiceNames].map(shellQuote).join(' ')}; do
    systemctl stop "$SERVER_SERVICE.service" >/dev/null 2>&1 || true
  done
  mkdir -p "$WORKDIR/.gravit-panel/backups"
  BACKUP="$WORKDIR/.gravit-panel/backups/$(date -u +%Y%m%dT%H%M%SZ).tar.gz"
  (
    cd "$WORKDIR"
    find . -type f \\( -name '*.jar' -o -name 'run.sh' -o -name 'user_jvm_args.txt' \\
      -o -name 'gravit-server.env' -o -name 'start-gravit-server.sh' -o -name 'eula.txt' \\) \\
      -not -path './.gravit-panel/download/*' -print0 |
      tar --null -czf "$BACKUP" --files-from=-
  )
fi
ARCH="$(uname -m)"
case "$ARCH" in
  x86_64|amd64) JRE_KIND=jre-x64; JRE_SHA=${shellQuote(internal.jre_x64_sha256!)} ;;
  aarch64|arm64) JRE_KIND=jre-aarch64; JRE_SHA=${shellQuote(internal.jre_aarch64_sha256!)} ;;
  *) echo "Unsupported architecture: $ARCH" >&2; exit 1 ;;
esac
BUNDLE="$WORKDIR/.gravit-panel/download/bundle.tar.gz"
JRE_ARCHIVE="$WORKDIR/.gravit-panel/download/jre.tar.gz"
${curl} -fL --retry 3 -o "$BUNDLE" ${shellQuote(`${artifactBase}/bundle`)}
echo ${shellQuote(internal.bundle_sha256!)}"  $BUNDLE" | sha256sum -c -
${curl} -fL --retry 3 -o "$JRE_ARCHIVE" "${
      artifactBase
    }/$JRE_KIND"
echo "$JRE_SHA  $JRE_ARCHIVE" | sha256sum -c -

rm -rf "$WORKDIR/.gravit-panel/jre"
mkdir -p "$WORKDIR/.gravit-panel/jre"
PAYLOAD="$(mktemp -d /tmp/gravit-bootstrap.XXXXXXXX)"
tar -xzf "$BUNDLE" --no-same-owner -C "$PAYLOAD"
tar -xzf "$JRE_ARCHIVE" --no-same-owner --strip-components=1 -C "$WORKDIR/.gravit-panel/jre"
JAVA="$WORKDIR/.gravit-panel/jre/bin/java"

${coreCommand}
"$JAVA" -jar "$PAYLOAD/ServerWrapper.jar" installAuthlib "$PAYLOAD/LauncherAuthlib.jar"
"$JAVA" -jar "$PAYLOAD/ServerWrapper.jar" installAuthlib "$PAYLOAD/ServerWrapperInline.jar"
install -m 0644 "$PAYLOAD/ServerWrapper.jar" "$WORKDIR/ServerWrapper.jar"
install -m 0644 "$PAYLOAD/ServerWrapperInline.jar" "$WORKDIR/ServerWrapperInline.jar"
printf 'eula=true\\n' > "$WORKDIR/eula.txt"

RCON_PORT=${rconPort}
for attempt in {1..100}; do
  if ! ss -H -ltn "sport = :$RCON_PORT" | grep -q .; then break; fi
  RCON_PORT=$((RCON_PORT + 1))
  [[ "$RCON_PORT" -le 35999 ]] || RCON_PORT=26000
  [[ "$attempt" -lt 100 ]] || { echo "Unable to allocate a local RCON port" >&2; exit 1; }
done
RCON_PASSWORD="$(head -c 32 /dev/urandom | base64 | tr '/+' '_-' | tr -d '\\n')"
touch "$WORKDIR/server.properties"
sed -i '/^enable-rcon=/d;/^rcon\\.port=/d;/^rcon\\.password=/d;/^broadcast-rcon-to-ops=/d' "$WORKDIR/server.properties"
cat >> "$WORKDIR/server.properties" <<RCON_PROPERTIES
enable-rcon=true
rcon.port=$RCON_PORT
rcon.password=$RCON_PASSWORD
broadcast-rcon-to-ops=false
RCON_PROPERTIES

cat > "$WORKDIR/gravit-server.env" <<'GRAVIT_ENV'
SERVERWRAPPER_ADDRESS=${shellQuote(config.launchServerAddress)}
SERVERWRAPPER_SERVER_NAME=${shellQuote(config.binding.name)}
SERVERWRAPPER_AUTH_ID=${shellQuote(config.binding.authId!)}
SERVERWRAPPER_CHECK_SERVER_TOKEN=${shellQuote(serverToken)}
_JAVA_OPTIONS=${shellQuote(jvmOptions)}
GRAVIT_ENV
chmod 0600 "$WORKDIR/gravit-server.env"

cat > "$WORKDIR/start-gravit-server.sh" <<'GRAVIT_START'
#!/usr/bin/env bash
set -Eeuo pipefail
WORKDIR="$(cd "$(dirname "$0")" && pwd -P)"
set -a
source "$WORKDIR/gravit-server.env"
set +a
JAVA="$WORKDIR/.gravit-panel/jre/bin/java"
cd "$WORKDIR"
${launchCommand}
GRAVIT_START
chmod 0750 "$WORKDIR/start-gravit-server.sh"
chown -R "$SERVICE_USER:$SERVICE_GROUP" "$WORKDIR"
install -d -m 0755 /var/lib/gravit-panel/servers
if [[ -e "$SERVICE_ROOT" && ! -L "$SERVICE_ROOT" ]]; then
  echo "Reserved service path is not a symbolic link: $SERVICE_ROOT" >&2
  exit 1
fi
ln -sfn "$WORKDIR" "$SERVICE_ROOT"

UNIT_TMP_DIR="$(mktemp -d /run/gravit-systemd.XXXXXXXX)"
UNIT_TMP="$UNIT_TMP_DIR/${serviceName}.service"
FIREWALL_ROOT=/usr/local/lib/gravit-panel-agent
install -d -m 0755 "$FIREWALL_ROOT"
cat > "$FIREWALL_ROOT/allow-local-rcon.sh" <<'RCON_FIREWALL'
#!/usr/bin/env bash
set -Eeuo pipefail
PORT="$1"
nft list table inet gravit_panel_agent >/dev/null 2>&1 || nft add table inet gravit_panel_agent
nft list set inet gravit_panel_agent rcon_ports >/dev/null 2>&1 || \
  nft 'add set inet gravit_panel_agent rcon_ports { type inet_service; }'
nft list chain inet gravit_panel_agent input >/dev/null 2>&1 || \
  nft 'add chain inet gravit_panel_agent input { type filter hook input priority 0; policy accept; }'
nft list chain inet gravit_panel_agent input | grep -Fq 'ip saddr 127.0.0.0/8 tcp dport @rcon_ports accept' || \
  nft insert rule inet gravit_panel_agent input ip saddr 127.0.0.0/8 tcp dport @rcon_ports accept
nft list chain inet gravit_panel_agent input | grep -Fq 'ip6 saddr ::1 tcp dport @rcon_ports accept' || \
  nft insert rule inet gravit_panel_agent input ip6 saddr ::1 tcp dport @rcon_ports accept
nft list chain inet gravit_panel_agent input | grep -Fq 'tcp dport @rcon_ports drop' || \
  nft add rule inet gravit_panel_agent input iifname != lo tcp dport @rcon_ports drop
nft add element inet gravit_panel_agent rcon_ports "{ $PORT }" 2>/dev/null || true
nft get element inet gravit_panel_agent rcon_ports "{ $PORT }" >/dev/null
RCON_FIREWALL
chmod 0755 "$FIREWALL_ROOT/allow-local-rcon.sh"
cat > "$UNIT_TMP" <<SYSTEMD_UNIT
[Unit]
Description=Gravit Minecraft server
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=$SERVICE_UID
Group=$SERVICE_GID
WorkingDirectory=$SERVICE_ROOT
ExecStartPre=+$FIREWALL_ROOT/allow-local-rcon.sh $RCON_PORT
ExecStart=$SERVICE_ROOT/start-gravit-server.sh
Restart=on-failure
RestartSec=10
TimeoutStopSec=120
KillSignal=SIGINT

[Install]
WantedBy=multi-user.target
SYSTEMD_UNIT
UPDATER_TOKEN="$(head -c 32 /dev/urandom | base64 | tr -d '\\n')"
AGENT_UNIT_TMP=
case "$ARCH" in
  x86_64|amd64) AGENT_BINARY="$PAYLOAD/gravit-agent-amd64" ;;
  aarch64|arm64) AGENT_BINARY="$PAYLOAD/gravit-agent-arm64" ;;
esac
if [[ -f "$AGENT_BINARY" ]]; then
  AGENT_CONFIG_ROOT=/etc/gravit-agent
  AGENT_BINDINGS_DIR="$AGENT_CONFIG_ROOT/bindings.d"
  install -d -m 0700 "$AGENT_CONFIG_ROOT" "$AGENT_BINDINGS_DIR"
  install -m 0755 "$AGENT_BINARY" /usr/local/bin/gravit-agent
  cat > "$AGENT_CONFIG_ROOT/config.json" <<'AGENT_CONFIG'
${JSON.stringify({ panelUrl: publicUrl, bindingsDir: '/etc/gravit-agent/bindings.d' }, null, 2)}
AGENT_CONFIG
  chmod 0600 "$AGENT_CONFIG_ROOT/config.json"
  cat > "$AGENT_BINDINGS_DIR/${config.binding.id!}.json" <<AGENT_BINDING
{
  "id": ${JSON.stringify(config.binding.id!)},
  "token": "$UPDATER_TOKEN",
  "unit": ${JSON.stringify(`${serviceName}.service`)},
  "root": ${JSON.stringify(`/var/lib/gravit-panel/servers/${config.binding.id!}`)},
  "rcon": {
    "address": "127.0.0.1:$RCON_PORT",
    "password": "$RCON_PASSWORD",
    "timeoutSeconds": 10
  }
}
AGENT_BINDING
  chmod 0600 "$AGENT_BINDINGS_DIR/${config.binding.id!}.json"
  AGENT_UNIT_TMP="$UNIT_TMP_DIR/gravit-agent.service"
  cat > "$AGENT_UNIT_TMP" <<AGENT_SERVICE
[Unit]
Description=Gravit Panel host agent
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
ExecStart=/usr/local/bin/gravit-agent -config /etc/gravit-agent/config.json
Restart=always
RestartSec=5
NoNewPrivileges=true
PrivateTmp=true
ProtectHome=false

[Install]
WantedBy=multi-user.target
AGENT_SERVICE
fi
UNITS=("$UNIT_TMP")
[[ -z "$AGENT_UNIT_TMP" ]] || UNITS+=("$AGENT_UNIT_TMP")
if ! systemd-analyze verify "\${UNITS[@]}"; then
  echo "Generated systemd units are invalid:" >&2
  sed -n '1,200p' "\${UNITS[@]}" >&2
  exit 1
fi
install -m 0644 "$UNIT_TMP" /etc/systemd/system/${serviceName}.service
if [[ -n "$AGENT_UNIT_TMP" ]]; then
  install -m 0644 "$AGENT_UNIT_TMP" /etc/systemd/system/gravit-agent.service
fi
rm -rf "$UNIT_TMP_DIR"
UNIT_TMP_DIR=
systemctl daemon-reload
for PACK_SERVICE in ${[serviceName, ...legacyServiceNames].map((name) => `${name}-pack-update`).map(shellQuote).join(' ')}; do
  systemctl disable --now "$PACK_SERVICE.service" "$PACK_SERVICE.timer" >/dev/null 2>&1 || true
  rm -f "/etc/systemd/system/$PACK_SERVICE.service" "/etc/systemd/system/$PACK_SERVICE.timer"
done
for LEGACY_SERVICE in ${legacyServiceNames.map(shellQuote).join(' ')}; do
  [[ "$LEGACY_SERVICE" == ${shellQuote(serviceName)} ]] && continue
  systemctl disable --now "$LEGACY_SERVICE.service" "$LEGACY_SERVICE-pack-update.timer" >/dev/null 2>&1 || true
  rm -f "/etc/systemd/system/$LEGACY_SERVICE.service" \
    "/etc/systemd/system/$LEGACY_SERVICE-pack-update.service" \
    "/etc/systemd/system/$LEGACY_SERVICE-pack-update.timer"
done
systemctl daemon-reload
systemctl enable --now ${serviceName}.service
if [[ -n "$AGENT_UNIT_TMP" ]]; then
  systemctl enable gravit-agent.service
  systemctl restart gravit-agent.service
fi
systemctl is-active --quiet ${serviceName}.service
rm -rf "$PAYLOAD"
PAYLOAD=
curl -f --retry 3 -sS -X POST -H 'content-type: application/json' \\
  --data "{\\"status\\":\\"installed\\",\\"updaterToken\\":\\"$UPDATER_TOKEN\\"}" \
  "$REPORT_URL" >/dev/null
trap - EXIT
echo "Server installed and started as ${serviceName}.service"
`
  }
}
