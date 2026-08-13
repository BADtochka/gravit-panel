import { database } from '../../db/client'
import { CredentialCipher } from '../../core/credential-cipher'
import { CredentialKeyService } from '../../core/credential-key.service'
import { env } from '../../core/env'
import { InstallationsStore } from './installations.store'
import { ControlFileService } from './control-file.service'
import { LaunchServerTransportService } from './launchserver-transport.service'
import { RemoteControlHttpService } from './remote-control-http.service'
import { RemoteControlSetupService } from './remote-control-setup.service'
import { RemoteControlStore } from './remote-control.store'
import { LaunchServerFilesService } from './launchserver-files.service'

export const installationsStore = new InstallationsStore(database)
export const credentialCipher = new CredentialCipher()
export const credentialKeyService = new CredentialKeyService(
  credentialCipher,
  env.CREDENTIAL_ENCRYPTION_KEY_PATH,
  env.CREDENTIAL_ENCRYPTION_KEY,
)
export const remoteControlStore = new RemoteControlStore(database, credentialCipher)
export const controlFileService = new ControlFileService()
export const launchServerFilesService = new LaunchServerFilesService()
export const remoteControlHttpService = new RemoteControlHttpService()
export const launchServerTransport = new LaunchServerTransportService(
  controlFileService,
  remoteControlHttpService,
  remoteControlStore,
)
export const remoteControlSetup = new RemoteControlSetupService(
  controlFileService,
  remoteControlHttpService,
  remoteControlStore,
)
