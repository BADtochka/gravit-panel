package pro.gravit.launchermodules.discordauthsystem;

import pro.gravit.launcher.base.ClientPermissions;
import pro.gravit.launchserver.auth.core.User;
import pro.gravit.utils.helper.SecurityHelper;

import java.util.UUID;

public class DiscordUser implements User {
    public final UUID uuid;
    public final String discordId;
    private String username;
    public String accessToken;
    public String refreshToken;
    public long expireIn;
    public String discordAccessToken;
    public String discordRefreshToken;
    public long discordExpireIn;
    public String minecraftAccessToken;
    private final ClientPermissions permissions;
    private boolean banned;

    public DiscordUser(UUID uuid, String discordId, String username, ClientPermissions permissions) {
        this.uuid = uuid;
        this.discordId = discordId;
        this.username = username;
        this.permissions = permissions;
        this.minecraftAccessToken = java.util.UUID.randomUUID().toString().replace("-", "");
    }

    @Override
    public String getUsername() {
        return username;
    }

    public void setUsername(String username) {
        this.username = username;
    }

    @Override
    public UUID getUUID() {
        return uuid;
    }

    @Override
    public ClientPermissions getPermissions() {
        return permissions;
    }

    @Override
    public boolean isBanned() {
        return banned;
    }

    public void setBanned(boolean banned) {
        this.banned = banned;
    }

    public String getDiscordId() {
        return discordId;
    }

    public void updateOAuth(String discordAccessToken, String discordRefreshToken, long expireIn) {
        this.discordAccessToken = discordAccessToken;
        this.discordRefreshToken = discordRefreshToken;
        this.discordExpireIn = expireIn;
        this.accessToken = SecurityHelper.randomStringToken();
        this.refreshToken = SecurityHelper.randomStringToken();
        this.expireIn = expireIn;
    }
}
