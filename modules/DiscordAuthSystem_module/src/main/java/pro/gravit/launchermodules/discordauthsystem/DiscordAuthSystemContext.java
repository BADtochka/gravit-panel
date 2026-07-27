package pro.gravit.launchermodules.discordauthsystem;

import pro.gravit.launchserver.LaunchServer;

public class DiscordAuthSystemContext {
    public static DiscordAuthSystemConfig config;
    public static JsonUserStorage storage;
    public static DiscordOAuthClient oauthClient;

    public static void initialize(LaunchServer server, DiscordAuthSystemConfig cfg) {
        config = cfg;
        storage = new JsonUserStorage(server);
        oauthClient = new DiscordOAuthClient(cfg);
    }
}
