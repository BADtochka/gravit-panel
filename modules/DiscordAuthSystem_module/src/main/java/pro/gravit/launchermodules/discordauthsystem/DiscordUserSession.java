package pro.gravit.launchermodules.discordauthsystem;

import pro.gravit.launchserver.auth.core.User;
import pro.gravit.launchserver.auth.core.UserSession;

public class DiscordUserSession implements UserSession {
    private final String id;
    private final DiscordUser user;
    private final long expireIn;
    private final String minecraftAccessToken;

    public DiscordUserSession(DiscordUser user, String accessToken) {
        this.id = accessToken;
        this.user = user;
        this.expireIn = user.expireIn;
        this.minecraftAccessToken = user.minecraftAccessToken;
    }

    @Override
    public String getID() {
        return id;
    }

    @Override
    public User getUser() {
        return user;
    }

    @Override
    public String getMinecraftAccessToken() {
        return minecraftAccessToken;
    }

    @Override
    public long getExpireIn() {
        return expireIn;
    }
}
