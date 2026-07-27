import { env } from '../../core/env'
import { database } from '../../db/client'
import { PanelAuthService } from './panel-auth.service'

export const panelAuthService = new PanelAuthService(database, {
  mode: env.PANEL_AUTH_MODE,
  publicUrl: env.PANEL_PUBLIC_URL,
  redirectUri: env.PANEL_AUTH_REDIRECT_URI,
  discordClientId: env.PANEL_DISCORD_CLIENT_ID,
  discordClientSecret: env.PANEL_DISCORD_CLIENT_SECRET,
  allowedDiscordUserIds: env.PANEL_DISCORD_ALLOWED_USER_IDS,
  secureCookies: env.PANEL_AUTH_COOKIE_SECURE,
})
