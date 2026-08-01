package pro.gravit.launchermodules.discordauthsystem;

import java.util.ArrayList;
import java.util.List;

public class DiscordAuthSystemConfig {
    public String clientId = "";
    public String clientSecret = "";
    public String redirectUrl = "";
    // A second Discord application redirect URI for the browser-based panel flow.
    // This must point to /webapi/auth/discord/portal on this LaunchServer.
    public String portalRedirectUrl = "";
    // Trusted panel URL to which a signed, short-lived identity ticket is returned.
    public String portalCallbackUrl = "";
    // Shared secret used to sign tickets returned to portalCallbackUrl. Use at least 32 random bytes.
    public String portalHmacSecret = "";
    public long portalTicketTtlSeconds = 60;
    public String discordAuthorizeUrl = "https://discord.com/oauth2/authorize";
    public String discordTokenUrl = "https://discord.com/api/oauth2/token";
    public String discordApiEndpoint = "https://discord.com/api/v10";
    public List<String> requiredGuildIds = new ArrayList<>();
    public boolean useGlobalNickname = true;
    public String usernameRegex = "^[a-zA-Z0-9_]{3,16}$";
    public String usernameFormat = "{discord}";
    public boolean autoRegister = true;
}
