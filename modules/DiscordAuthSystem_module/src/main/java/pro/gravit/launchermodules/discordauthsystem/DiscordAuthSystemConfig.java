package pro.gravit.launchermodules.discordauthsystem;

import java.util.ArrayList;
import java.util.List;

public class DiscordAuthSystemConfig {
    public String clientId = "";
    public String clientSecret = "";
    public String redirectUrl = "";
    public String discordAuthorizeUrl = "https://discord.com/oauth2/authorize";
    public String discordTokenUrl = "https://discord.com/api/oauth2/token";
    public String discordApiEndpoint = "https://discord.com/api/v10";
    public List<String> requiredGuildIds = new ArrayList<>();
    public boolean useGlobalNickname = true;
    public String usernameRegex = "^[a-zA-Z0-9_]{3,16}$";
    public String usernameFormat = "{discord}";
    public boolean autoRegister = true;
}
