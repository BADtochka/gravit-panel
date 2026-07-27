import { describe, expect, test } from 'bun:test'
import type { GravitInstallation } from '@gravit-panel/shared'
import type { ControlFileService } from '../gravit/control-file.service'
import type { JobTaskContext } from '../jobs/jobs.runner'
import { AuthUsersService } from './auth-users.service'

const installation: GravitInstallation = {
  id: '0da297da-3055-4785-aa1a-57fba3beba11',
  name: 'default',
  path: '/srv/gravit/default',
  address: 'localhost:17549',
  projectName: 'MY_PROJECT',
  sourceRepository: 'https://github.com/GravitLauncher/LauncherDockered',
  sourceRevision: '723203b56f8d58f2447edd20ac8a5b84a31ef816',
  createdAt: '2026-07-27T12:00:00.000Z',
  updatedAt: '2026-07-27T12:00:00.000Z',
}

const context = (): JobTaskContext => ({
  signal: new AbortController().signal,
  log: () => {},
  progress: () => {},
})

describe('AuthUsersService', () => {
  test('lists sanitized FileAuthSystem users without password hashes', async () => {
    const commands: string[] = []
    const volume = {
      exists: async () => true,
      readFile: async (_installation: GravitInstallation, path: string) => {
        if (path === 'LaunchServer.json') {
          return JSON.stringify({
            auth: { std: { core: { type: 'fileauthsystem' } } },
          })
        }
        return JSON.stringify({
          '11111111-1111-1111-1111-111111111111': {
            username: 'alice',
            uuid: '11111111-1111-1111-1111-111111111111',
            password: 'secret-hash',
          },
        })
      },
      writeFileAtomic: async () => {},
    }
    const control = {
      executeAuthCommand: async (_installation: GravitInstallation, command: string) => {
        commands.push(command)
        return ['ok']
      },
    } as ControlFileService
    const service = new AuthUsersService(control, volume)

    const result = await service.list(installation, 'std')

    expect(result.managed).toBe(true)
    expect(commands).toContain('config auth.std.core save')
    expect(result.users).toEqual([
      { username: 'alice', uuid: '11111111-1111-1111-1111-111111111111' },
    ])
    expect(JSON.stringify(result)).not.toContain('secret-hash')
  })

  test('returns an unmanaged capability for SQL providers', async () => {
    const volume = {
      exists: async () => false,
      readFile: async () =>
        JSON.stringify({
          auth: { std: { core: { type: 'sql' } } },
        }),
      writeFileAtomic: async () => {},
    }
    const service = new AuthUsersService({} as ControlFileService, volume)

    const result = await service.list(installation, 'std')

    expect(result.managed).toBe(false)
    expect(result.users).toEqual([])
    expect(result.reason).toContain('external database')
  })

  test('registers a user then persists the FileAuthSystem database', async () => {
    const commands: string[] = []
    const volume = {
      exists: async () => true,
      readFile: async () =>
        JSON.stringify({
          auth: { std: { core: { type: 'fileauthsystem' } } },
        }),
      writeFileAtomic: async () => {},
    }
    const control = {
      executeAuthCommand: async (_installation: GravitInstallation, command: string) => {
        commands.push(command)
        if (command.includes('getuserbyusername')) return ['User BAD not found']
        if (command.includes('register')) return ["User 'BAD' registered"]
        return ['ok']
      },
    } as ControlFileService
    const service = new AuthUsersService(control, volume)

    await service.create(
      installation,
      {
        installationId: installation.id,
        authId: 'std',
        username: 'BAD',
        email: 'bad@mail.com',
        password: '123123',
      },
      context(),
    )

    expect(commands).toEqual([
      'config auth.std.core getuserbyusername BAD',
      'config auth.std.core register BAD bad@mail.com 123123',
      'config auth.std.core save',
    ])
  })

  test('rejects duplicate usernames before calling register', async () => {
    const commands: string[] = []
    const volume = {
      exists: async () => true,
      readFile: async () =>
        JSON.stringify({
          auth: { std: { core: { type: 'fileauthsystem' } } },
        }),
      writeFileAtomic: async () => {},
    }
    const control = {
      executeAuthCommand: async (_installation: GravitInstallation, command: string) => {
        commands.push(command)
        return [
          "User BAD: UserEntity{username='BAD', uuid=1eeca692-cf72-4fe0-ac63-a2460381cf77, permissions=ClientPermissions{roles=, actions=}}",
        ]
      },
    } as ControlFileService
    const service = new AuthUsersService(control, volume)

    await expect(
      service.create(
        installation,
        {
          installationId: installation.id,
          authId: 'std',
          username: 'BAD',
          email: 'bad@mail.com',
          password: '123123',
        },
        context(),
      ),
    ).rejects.toThrow('already registered')
    expect(commands.some((command) => command.includes('register'))).toBe(false)
  })

  test('deletes a user from Database.json and reloads the provider', async () => {
    const commands: string[] = []
    let database = JSON.stringify({
      '11111111-1111-1111-1111-111111111111': {
        username: 'alice',
        uuid: '11111111-1111-1111-1111-111111111111',
        password: 'secret-hash',
      },
    })
    const volume = {
      exists: async () => true,
      readFile: async (_installation: GravitInstallation, path: string) => {
        if (path === 'LaunchServer.json') {
          return JSON.stringify({
            auth: { std: { core: { type: 'fileauthsystem' } } },
          })
        }
        return database
      },
      writeFileAtomic: async (_installation: GravitInstallation, path: string, bytes: Uint8Array) => {
        expect(path).toBe('config/FileAuthSystem/Database.json')
        database = new TextDecoder().decode(bytes)
      },
    }
    const control = {
      executeAuthCommand: async (_installation: GravitInstallation, command: string) => {
        commands.push(command)
        return ['ok']
      },
    } as ControlFileService
    const service = new AuthUsersService(control, volume)

    await service.delete(
      installation,
      { installationId: installation.id, authId: 'std', username: 'alice', confirmDelete: true },
      context(),
    )

    expect(JSON.parse(database)).toEqual({})
    expect(commands).toEqual([
      'config auth.std.core save',
      'config auth.std.core reload',
    ])
    expect(database).not.toContain('secret-hash')
  })
})
