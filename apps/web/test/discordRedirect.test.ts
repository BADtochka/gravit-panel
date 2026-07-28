import { describe, expect, test } from 'bun:test'
import { defaultDiscordRedirectUrl } from '../src/lib/discord-redirect'

describe('default Discord OAuth redirect URL', () => {
  test('uses the selected public Launcher address', () => {
    expect(defaultDiscordRedirectUrl('mine.example.com')).toBe(
      'https://mine.example.com/webapi/auth/discord',
    )
  })

  test('preserves a supplied scheme and supports local development', () => {
    expect(defaultDiscordRedirectUrl('https://launcher.example.test/game/')).toBe(
      'https://launcher.example.test/game/webapi/auth/discord',
    )
    expect(defaultDiscordRedirectUrl('localhost:17549')).toBe(
      'http://localhost:17549/webapi/auth/discord',
    )
  })
})
