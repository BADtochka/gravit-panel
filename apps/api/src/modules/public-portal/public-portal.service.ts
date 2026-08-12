import { createHmac, createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import type { Database } from 'bun:sqlite'

const playerSessionLifetimeMs = 7 * 24 * 60 * 60 * 1000
const maxSkinBytes = 1024 * 1024

export interface PortalTicket {
  uuid: string
  username: string
  discordId: string
  avatarHash?: string
  exp: number
  nonce: string
}

export interface PublicPageSettings {
  title: string
  description: string
  hiddenLauncherVariants: string[]
  updatedAt: string
}

export interface PublicPlayerSession {
  playerUuid: string
  discordId: string
  avatarHash: string | null
  username: string
  expiresAt: string
}

const hash = (value: string | Uint8Array) =>
  createHash('sha256').update(typeof value === 'string' ? value : Buffer.from(value)).digest('hex')
const now = () => new Date().toISOString()
const randomToken = () => randomBytes(32).toString('base64url')

export class PublicPortalService {
  constructor(private readonly database: Database, private readonly hmacSecret?: string) {}

  settings(): PublicPageSettings {
    const item = this.database.query<{
      title: string
      description: string
      hiddenLauncherVariantsJson: string
      updatedAt: string
    }, []>(`SELECT title, description, hidden_launcher_variants_json AS hiddenLauncherVariantsJson, updated_at AS updatedAt FROM public_page_settings WHERE id = 1`).get()
    return item ? { ...item, hiddenLauncherVariants: this.parseVariants(item.hiddenLauncherVariantsJson) } : {
      title: 'Наш сервер',
      description: 'Войдите через Discord, чтобы скачать лаунчер и начать играть.',
      hiddenLauncherVariants: [],
      updatedAt: '',
    }
  }

  updateSettings(input: Pick<PublicPageSettings, 'title' | 'description' | 'hiddenLauncherVariants'>) {
    const updatedAt = now()
    this.database.query(`INSERT INTO public_page_settings (id, title, description, hidden_launcher_variants_json, updated_at) VALUES (1, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET title = excluded.title, description = excluded.description, hidden_launcher_variants_json = excluded.hidden_launcher_variants_json, updated_at = excluded.updated_at`).run(input.title.trim(), input.description.trim(), JSON.stringify(input.hiddenLauncherVariants), updatedAt)
    return this.settings()
  }

  completeTicket(ticket: string): { session: string; player: PublicPlayerSession } {
    const payload = this.verifyTicket(ticket)
    this.cleanup()
    const consumed = this.database.query('INSERT OR IGNORE INTO public_player_ticket_nonces (nonce, expires_at) VALUES (?, ?)').run(payload.nonce, new Date(payload.exp * 1000).toISOString())
    if (consumed.changes !== 1) throw new Error('The authorization ticket has already been used.')
    const session = randomToken()
    const expiresAt = new Date(Date.now() + playerSessionLifetimeMs).toISOString()
    const avatarHash = this.validAvatarHash(payload.avatarHash) ? payload.avatarHash : null
    this.database.query('INSERT INTO public_player_sessions (session_hash, player_uuid, discord_id, discord_avatar_hash, username, expires_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)').run(hash(session), payload.uuid, payload.discordId, avatarHash, payload.username, expiresAt, now())
    return { session, player: { playerUuid: payload.uuid, discordId: payload.discordId, avatarHash, username: payload.username, expiresAt } }
  }

  session(token?: string): PublicPlayerSession | null {
    if (!token) return null
    this.cleanup()
    return this.database.query<PublicPlayerSession, [string]>('SELECT player_uuid AS playerUuid, discord_id AS discordId, discord_avatar_hash AS avatarHash, username, expires_at AS expiresAt FROM public_player_sessions WHERE session_hash = ?').get(hash(token)) ?? null
  }

  revokeSession(token?: string) { if (token) this.database.query('DELETE FROM public_player_sessions WHERE session_hash = ?').run(hash(token)) }

  setSkin(player: PublicPlayerSession, image: Uint8Array) {
    const dimensions = this.pngDimensions(image)
    const updatedAt = now()
    this.database.query('INSERT INTO player_skins (player_uuid, username, image, sha256, width, height, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT(player_uuid) DO UPDATE SET username = excluded.username, image = excluded.image, sha256 = excluded.sha256, width = excluded.width, height = excluded.height, updated_at = excluded.updated_at').run(player.playerUuid, player.username, image, hash(image), dimensions.width, dimensions.height, updatedAt)
    return { ...dimensions, sha256: hash(image), updatedAt }
  }

  skinForUsername(username: string) {
    return this.database.query<{ image: Uint8Array; sha256: string; updatedAt: string }, [string]>('SELECT image, sha256, updated_at AS updatedAt FROM player_skins WHERE username = ? COLLATE NOCASE').get(username)
  }

  skinForPlayer(player: PublicPlayerSession) {
    return this.database.query<{ sha256: string; width: number; height: number; updatedAt: string }, [string]>('SELECT sha256, width, height, updated_at AS updatedAt FROM player_skins WHERE player_uuid = ?').get(player.playerUuid) ?? null
  }

  private verifyTicket(ticket: string): PortalTicket {
    if (!this.hmacSecret || this.hmacSecret.length < 32) throw new Error('Public portal HMAC secret is not configured.')
    const [payload, signature, ...rest] = ticket.split('.')
    if (!payload || !signature || rest.length) throw new Error('Invalid authorization ticket.')
    const expected = createHmac('sha256', this.hmacSecret).update(payload).digest('base64url')
    if (signature.length !== expected.length || !timingSafeEqual(Buffer.from(signature), Buffer.from(expected))) throw new Error('Invalid authorization ticket signature.')
    let parsed: PortalTicket
    try { parsed = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as PortalTicket } catch { throw new Error('Invalid authorization ticket payload.') }
    if (!/^[0-9a-f]{8}-[0-9a-f-]{27}$/i.test(parsed.uuid) || !/^[0-9]{5,30}$/.test(parsed.discordId) || !/^[A-Za-z0-9_]{2,16}$/.test(parsed.username) || !/^[A-Za-z0-9_-]{20,}$/.test(parsed.nonce) || !Number.isSafeInteger(parsed.exp) || parsed.exp * 1000 <= Date.now()) throw new Error('Authorization ticket is invalid or expired.')
    return parsed
  }

  private pngDimensions(bytes: Uint8Array) {
    if (bytes.byteLength < 24 || bytes.byteLength > maxSkinBytes || !bytes.slice(0, 8).every((value, index) => value === [137, 80, 78, 71, 13, 10, 26, 10][index])) throw new Error('Skin must be a PNG file up to 1 MiB.')
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
    const width = view.getUint32(16)
    const height = view.getUint32(20)
    if (!((width === 64 && height === 64) || (width === 128 && height === 128))) throw new Error('Skin must be 64x64 or 128x128 pixels.')
    return { width, height }
  }

  private parseVariants(value: string) { try { const items = JSON.parse(value); return Array.isArray(items) && items.every((item) => item === 'jar' || item === 'windows-x64') ? items : [] } catch { return [] } }
  private validAvatarHash(value: unknown): value is string { return typeof value === 'string' && /^[A-Za-z0-9_]{2,128}$/.test(value) }
  private cleanup() { const time = now(); this.database.query('DELETE FROM public_player_ticket_nonces WHERE expires_at <= ?').run(time); this.database.query('DELETE FROM public_player_sessions WHERE expires_at <= ?').run(time) }
}
