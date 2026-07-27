export type HealthStatus = 'ok' | 'degraded' | 'error'

export interface ApiHealth {
  service: 'gravit-panel-api'
  status: HealthStatus
  version: string
  time: string
}

export interface WorkspaceApp {
  name: string
  title: string
  description: string
}

export type JobType =
  | 'demo.noop'
  | 'docker.launcherdockered.install'
  | 'docker.launcherdockered.delete'
  | 'gravit.auth.file.install'
  | 'gravit.auth.provider.apply'
  | 'gravit.auth.user.create'
  | 'gravit.auth.user.password'
  | 'gravit.auth.user.delete'
  | 'gravit.remote-control.setup'
  | 'gravit.module.install'
  | 'gravit.module.config.apply'
  | 'gravit.prestarter.install'
  | 'gravit.workspace.apply'
  | 'gravit.launcher.build'
  | 'gravit.launcher.customize'
  | 'gravit.client.build'
  | 'gravit.mods.install'
  | 'gravit.mods.update'
  | 'gravit.mods.toggle'
  | 'gravit.mods.remove'
export type JobStatus = 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled'
export type JobEventType =
  | 'queued'
  | 'started'
  | 'progress'
  | 'log'
  | 'completed'
  | 'failed'
  | 'cancelled'

export interface JobRecord {
  id: string
  type: JobType
  status: JobStatus
  progress: number
  input: Record<string, unknown>
  result: Record<string, unknown> | null
  error: string | null
  createdAt: string
  startedAt: string | null
  finishedAt: string | null
}

export interface JobEvent {
  sequence: number
  jobId: string
  type: JobEventType
  message: string
  progress: number | null
  createdAt: string
}

export interface JobsResponse {
  items: JobRecord[]
  runningIds: string[]
}

export type DockerPreflightCheckId = 'docker-cli' | 'docker-compose' | 'docker-port'
export type DockerPreflightCheckStatus = 'passed' | 'failed'

export interface DockerPreflightCheck {
  id: DockerPreflightCheckId
  title: string
  status: DockerPreflightCheckStatus
  message: string
  details: string | null
  remediation: string | null
}

export interface DockerPreflightResponse {
  ready: boolean
  checkedAt: string
  port: number
  checks: DockerPreflightCheck[]
  source: {
    repository: string
    revision: string
    file: string
  }
}

export type LauncherDockeredInstallMode = 'clone' | 'import' | 'attach'

export interface LauncherDockeredInstallInput {
  mode: LauncherDockeredInstallMode
  installationName: string
  importPath?: string
  address: string
  projectName: string
}

export interface LauncherDockeredInstallRequest extends LauncherDockeredInstallInput {
  confirmInstallation: true
}

export interface DockerInstallConfiguration {
  installationsRoot: string
  source: DockerPreflightResponse['source']
}

export interface LauncherDockeredInstallResult {
  installationPath: string
  mode: LauncherDockeredInstallMode
  address: string
  projectName: string
  sourceRepository: string
  sourceRevision: string
  environmentBackupPath: string | null
}

export interface LauncherDockeredRemovalResult {
  installationId: string
  installationPath: string
  composeResourcesRemoved: boolean
  filesRemoved: boolean
  registrationRemoved: boolean
}

export interface GravitInstallation {
  id: string
  name: string
  path: string
  address: string
  projectName: string
  sourceRepository: string
  sourceRevision: string
  createdAt: string
  updatedAt: string
}

export interface AuthProviderSummary {
  id: string
  displayName: string
  coreType: string
  isDefault: boolean
  visible: boolean
}

export type AuthCoreRecipeId =
  | 'memory'
  | 'sql'
  | 'http'
  | 'merge'
  | 'file'
  | 'mojang'
  | 'microsoft'

export type AuthPasswordVerifierType = 'bcrypt' | 'digest' | 'doubleDigest' | 'phpass'
export type AuthSqlDriverPreset = 'postgresql' | 'mariadb' | 'mysql'

export interface AuthRecipe {
  id: AuthCoreRecipeId
  title: string
  description: string
  coreType: string
  moduleId: string | null
  requiresModuleIds: string[]
  source: SourcePin
}

export interface AuthConfiguration {
  installationId: string
  providers: AuthProviderSummary[]
  recipes: AuthRecipe[]
}

export interface AuthTextureProviderConfig {
  type: 'void' | 'request'
  skinURL?: string
  cloakURL?: string
}

export interface AuthPasswordVerifierConfig {
  type: AuthPasswordVerifierType
  algo?: string
  cost?: number
  toHexMode?: boolean
}

export interface AuthSqlHolderConfig {
  driverPreset: AuthSqlDriverPreset
  jdbcUrl: string
  username: string
  password?: string
  hikariMaxLifetime?: number
  initializeAtStart?: boolean
}

export interface AuthSqlCoreConfig {
  holder: AuthSqlHolderConfig
  expireSeconds?: number
  table?: string
  uuidColumn?: string
  usernameColumn?: string
  accessTokenColumn?: string
  passwordColumn?: string
  serverIDColumn?: string
  hardwareIdColumn?: string
  tableHWID?: string
  tableHWIDLog?: string
  passwordVerifier: AuthPasswordVerifierConfig
}

export interface AuthHttpCoreConfig {
  userByUsername: string
  userByUuid: string
  userByToken: string
  refreshAccessToken: string
  authorize: string
  checkServer: string
  joinServer: string
  bearerToken?: string
}

export interface AuthMergeCoreConfig {
  list: string[]
}

export interface AuthProviderDetail {
  id: string
  displayName: string
  coreType: string
  isDefault: boolean
  visible: boolean
  textureProvider: AuthTextureProviderConfig | null
  sql: Omit<AuthSqlCoreConfig, 'holder'> & {
    holder: Omit<AuthSqlHolderConfig, 'password'> & { passwordConfigured: boolean }
  } | null
  http: Omit<AuthHttpCoreConfig, 'bearerToken'> & { bearerConfigured: boolean } | null
  merge: AuthMergeCoreConfig | null
}

export interface AuthProviderApplyInput {
  installationId: string
  authId: string
  recipeId: AuthCoreRecipeId
  displayName: string
  isDefault: boolean
  visible: boolean
  textureProvider?: AuthTextureProviderConfig
  sql?: AuthSqlCoreConfig
  http?: AuthHttpCoreConfig
  merge?: AuthMergeCoreConfig
  confirmConfigWrite: true
}

export interface AuthProviderApplyResult {
  installationId: string
  authId: string
  coreType: string
  configBackupPath: string | null
  restarted: boolean
  source: SourcePin
}

export interface FileAuthInstallInput {
  installationId: string
  authId: string
  confirmConfigWrite: true
}

export interface FileAuthInstallResult {
  installationId: string
  requestedAuthId: string
  configuredAuthId: string
  alreadyConfigured: boolean
  configBackupPath: string | null
  source: SourcePin
}

export interface AuthUserSummary {
  username: string
  uuid: string
}

export interface AuthUsersResponse {
  installationId: string
  authId: string
  coreType: string
  managed: boolean
  reason: string | null
  users: AuthUserSummary[]
}

export interface AuthUserCreateInput {
  installationId: string
  authId: string
  username: string
  email: string
  password: string
}

export interface AuthUserPasswordInput {
  installationId: string
  authId: string
  username: string
  password: string
}

export interface AuthUserDeleteInput {
  installationId: string
  authId: string
  username: string
  confirmDelete: true
}

export interface AuthUserMutationResult {
  installationId: string
  authId: string
  username: string
}

export interface FileAuthModuleConfig {
  autoSave: boolean
}

export interface FileAuthModuleConfigApplyInput {
  installationId: string
  autoSave: boolean
  confirmConfigWrite: true
}

export type LaunchServerInspectionCommand = 'serverStatus' | 'securitycheck'

export interface LaunchServerCommandResult {
  installationId: string
  command: LaunchServerInspectionCommand
  transport: 'control-file' | 'remote-control'
  fallbackReason?: string
  lines: string[]
  startedAt: string
  finishedAt: string
  source: {
    repository: string
    revision: string
    file: string
  }
}

export interface RemoteControlConfiguration {
  encryptionConfigured: boolean
  encryptionSource: 'environment' | 'generated' | 'memory' | null
  canGenerateEncryptionKey: boolean
  configuredInstallationIds: string[]
  allowedCommands: LaunchServerInspectionCommand[]
  source: {
    repository: string
    revision: string
    file: string
  }
}

export interface RemoteControlSetupInput {
  installationId: string
  endpoint: string
  replaceExistingTokens: true
}

export interface GenerateCredentialEncryptionKeyInput {
  confirmGeneration: true
}

export type GravitModuleKind = 'server' | 'launcher'
export type GravitModuleCategory = 'server' | 'launcher' | 'auth'

export interface GravitModuleCatalogItem {
  id: string
  name: string
  directory: string
  jar: string
  kind: GravitModuleKind
  category: GravitModuleCategory
  description: string
}

export interface GravitModuleSource {
  repository: string
  revision: string
}

export interface GravitModuleRelease {
  repository: string
  tag: string
  revision: string
  asset: string
  downloadUrl: string
  sha256: string
}

export interface GravitModuleCommandSource {
  repository: string
  revision: string
  files: readonly string[]
}

export interface GravitModuleCatalog {
  source: GravitModuleSource
  release: GravitModuleRelease
  commandSource: GravitModuleCommandSource
  serverModules: GravitModuleCatalogItem[]
  launcherModules: GravitModuleCatalogItem[]
  authModules: GravitModuleCatalogItem[]
}

export interface GravitModuleRuntimeItem {
  id: string
  available: boolean
  loaded: boolean
  pendingJobId: string | null
}

export interface GravitModuleState {
  installationId: string
  checkedAt: string
  items: GravitModuleRuntimeItem[]
}

export interface GravitModuleInstallInput {
  installationId: string
  moduleId: string
}

export interface GravitModuleInstallResult {
  installationId: string
  moduleId: string
  moduleName: string
  kind: GravitModuleKind
  command: string
  alreadyLoaded: boolean
  sourceRevision: string
  releaseTag: string
}

export type MinecraftLoader = 'VANILLA' | 'FABRIC' | 'FORGE' | 'NEOFORGE' | 'QUILT'

export interface SourcePin {
  repository: string
  revision: string
  file?: string
}

export interface ClientCompatibility {
  minecraftVersion: string
  requiresPatchedAuthlib: true
  authlibArtifact: string
  source: SourcePin
}

export interface LauncherArtifact {
  variant: 'jar' | 'windows-x64'
  filename: string
  size: number
  sha256: string
  modifiedAt: string
  downloadPath: string
}

export interface LauncherRuntimeInstallResult {
  repository: string
  tag: string
  revision: string
  compatibleLauncherVersion: string
  moduleSha256: string
  resourcesSha256: string
  alreadyInstalled: boolean
  alreadyLoaded: boolean
}

export interface LauncherBuildResult {
  installationId: string
  command: 'build'
  artifacts: LauncherArtifact[]
  runtime: LauncherRuntimeInstallResult
  source: SourcePin
}

export interface LauncherCustomizationAsset {
  id: 'logo' | 'background' | 'favicon'
  path: string
  sha256: string
}

export interface LauncherCustomizationState {
  installationId: string
  customized: boolean
  assets: LauncherCustomizationAsset[]
  source: SourcePin
}

export interface LauncherCustomizationResult extends LauncherCustomizationState {
  backups: string[]
  build: LauncherBuildResult
}

export interface ClientBuildInput {
  installationId: string
  name: string
  minecraftVersion: string
  loader: MinecraftLoader
  mods: string[]
}

export interface ClientBuildResult {
  installationId: string
  name: string
  minecraftVersion: string
  loader: MinecraftLoader
  mods: string[]
  profilePath: string
  updatesPath: string
  compatibility: ClientCompatibility
  source: SourcePin
}

export interface ClientPreparationState {
  installationId: string
  workspaceApplied: boolean
  prestarterInstalled: boolean
  launcherBuilt: boolean
}

export interface ClientProfileState {
  installationId: string
  name: string
  built: boolean
}

export interface ClientProfileDescriptor {
  name: string
  minecraftVersion: string | null
  loader: MinecraftLoader | null
}

export interface MinecraftVersionCatalog {
  items: Array<{
    id: string
    releaseTime: string
  }>
  latestRelease: string
  source: {
    manifestUrl: string
    fetchedAt: string
  }
}

export interface WorkspaceApplyInput {
  installationId: string
  confirmDestructive: true
}

export interface WorkspaceApplyResult {
  installationId: string
  manifestUrl: string
  manifestSha256: string
  snapshotPath: string | null
  source: SourcePin
}

export interface PrestarterInstallResult {
  installationId: string
  path: string
  releaseTag: string
  sha256: string
  backupPath: string | null
  source: SourcePin
}

export interface ModrinthProject {
  projectId: string
  slug: string
  title: string
  description: string
  author: string
  iconUrl: string | null
  downloads: number
  versions: string[]
  loaders: string[]
}

export interface InstalledMod {
  filename: string
  disabled: boolean
  size: number
  sha1: string
  projectId: string | null
  versionId: string | null
  versionName: string | null
}

export interface ModInstallInput {
  installationId: string
  profile: string
  minecraftVersion: string
  loader: Exclude<MinecraftLoader, 'VANILLA'>
  slugs: string[]
}

export const workspaceApps: WorkspaceApp[] = [
  {
    name: 'setup',
    title: 'Setup Wizard',
    description: 'Guided GravitLauncher installation and configuration',
  },
  {
    name: 'modules',
    title: 'Modules',
    description: 'Install and configure LaunchServer and launcher modules',
  },
  {
    name: 'clients',
    title: 'Clients',
    description: 'Build Minecraft clients through LaunchServer commands',
  },
  {
    name: 'mods',
    title: 'Mods',
    description: 'Search, install, and update mods with Modrinth support',
  },
  {
    name: 'jobs',
    title: 'Jobs',
    description: 'Track background operations and inspect their logs',
  },
]
