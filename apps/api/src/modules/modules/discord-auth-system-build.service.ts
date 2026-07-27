import { existsSync } from 'node:fs'
import { mkdir, rename, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { DiscordAuthSystemBuildResult, GravitInstallation } from '@gravit-panel/shared'
import { ContainerVolumeService } from '../docker/container-volume.service'
import type { JobTaskContext } from '../jobs/jobs.runner'
import {
  discordAuthSystemArtifactVersion,
  discordAuthSystemJarName,
} from './module-catalog'

const __dirname = dirname(fileURLToPath(import.meta.url))
const projectRoot = join(__dirname, '..', '..', '..', '..', '..')
const moduleDir = join(projectRoot, 'modules', 'DiscordAuthSystem_module')
const outputDir = Bun.env.MODULE_ARTIFACTS_DIR ?? join(projectRoot, 'data', 'modules')
const artifactVersionPath = 'modules/.gravit-panel-discordauthsystem-version'

const runDockerBuild = async (context: JobTaskContext): Promise<DiscordAuthSystemBuildResult> => {
  context.progress(5, 'Preparing Docker build for DiscordAuthSystem module')
  if (!existsSync(moduleDir)) {
    throw new Error(`DiscordAuthSystem module source not found at ${moduleDir}`)
  }

  const imageTag = `gravit-panel/discord-auth-module-builder:${crypto.randomUUID()}`
  const containerName = `discord-auth-module-extract-${crypto.randomUUID()}`
  const jarName = discordAuthSystemJarName

  context.progress(15, 'Building module image with Docker')
  const build = await runCommand(
    ['docker', 'build', '-t', imageTag, '.'],
    moduleDir,
    context,
  )
  if (build.exitCode !== 0) {
    throw new Error(`Docker build failed: ${build.stderr || build.stdout}`)
  }

  context.progress(60, 'Extracting module JAR from image')
  const create = await runCommand(['docker', 'create', '--name', containerName, imageTag], moduleDir)
  if (create.exitCode !== 0) {
    throw new Error(`Unable to create extraction container: ${create.stderr || create.stdout}`)
  }

  try {
    await mkdir(outputDir, { recursive: true })
    const targetPath = join(outputDir, jarName)
    const tempPath = `${targetPath}.pending-${crypto.randomUUID()}`
    const cp = await runCommand(
      ['docker', 'cp', `${containerName}:/${jarName}`, tempPath],
      moduleDir,
    )
    if (cp.exitCode !== 0) {
      throw new Error(`Unable to extract module JAR: ${cp.stderr || cp.stdout}`)
    }
    await rename(tempPath, targetPath)
    context.progress(80, `Module JAR written to ${targetPath}`)
    return { jarPath: targetPath, copiedToInstallation: false }
  } finally {
    await runCommand(['docker', 'rm', '-f', containerName], moduleDir).catch(() => {})
    await runCommand(['docker', 'rmi', '-f', imageTag], moduleDir).catch(() => {})
  }
}

const copyJarToInstallation = async (
  installation: GravitInstallation,
  jarPath: string,
  context: JobTaskContext,
): Promise<void> => {
  const volume = new ContainerVolumeService()
  const moduleJarRelative = `modules/${discordAuthSystemJarName}`
  const bytes = await Bun.file(jarPath).bytes()
  context.progress(85, `Copying JAR to installation ${installation.name} modules directory`)
  await volume.writeFileAtomic(installation, moduleJarRelative, bytes, '0644')
  if (!(await volume.exists(installation, moduleJarRelative))) {
    throw new Error('DiscordAuthSystem module JAR was not published to the LaunchServer volume')
  }
  await volume.writeFileAtomic(
    installation,
    artifactVersionPath,
    new TextEncoder().encode(`${discordAuthSystemArtifactVersion}\n`),
    '0644',
  )
  context.progress(95, 'Module JAR published to LaunchServer modules directory')
}

const runCommand = (
  command: string[],
  cwd: string,
  context?: JobTaskContext,
): Promise<{ exitCode: number; stdout: string; stderr: string }> => {
  return new Promise((resolve) => {
    const process = Bun.spawn(command, {
      cwd,
      stdout: 'pipe',
      stderr: 'pipe',
    })
    const stdout: string[] = []
    const stderr: string[] = []
    const readerOut = process.stdout.getReader()
    const readerErr = process.stderr.getReader()

    const readStream = async (
      reader: ReadableStreamDefaultReader<Uint8Array>,
      buffer: string[],
    ): Promise<void> => {
      const decoder = new TextDecoder()
      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        const chunk = decoder.decode(value, { stream: true })
        buffer.push(chunk)
        context?.log(chunk.trimEnd())
      }
    }

    Promise.all([readStream(readerOut, stdout), readStream(readerErr, stderr)]).then(async () => {
      const exitCode = await process.exited
      resolve({
        exitCode,
        stdout: stdout.join(''),
        stderr: stderr.join(''),
      })
    })
  })
}

export class DiscordAuthSystemBuildService {
  async build(
    context: JobTaskContext,
    installation: GravitInstallation,
  ): Promise<DiscordAuthSystemBuildResult> {
    const result = await runDockerBuild(context)
    await copyJarToInstallation(installation, result.jarPath, context)
    return { ...result, installationId: installation.id, copiedToInstallation: true }
  }
}
