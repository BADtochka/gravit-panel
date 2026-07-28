package pro.gravit.launchermodules.discordauthsystem;

import org.junit.jupiter.api.Test;
import pro.gravit.launcher.base.ClientPermissions;

import java.util.UUID;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNotEquals;

class DiscordAuthCoreProviderTest {
    @Test
    void keepsMinecraftAndOAuthAccessTokensInTheirProtocolFields() {
        DiscordUser user = new DiscordUser(
            UUID.fromString("aa90f8c5-1214-3f4e-a64c-3afde444097b"),
            "1531370122256711680",
            "formallybad",
            ClientPermissions.DEFAULT
        );
        user.minecraftAccessToken = "minecraft-access-token";
        user.updateOAuth("discord-access-token", "discord-refresh-token", 604800);

        var report = DiscordAuthCoreProvider.reportFor(
            user,
            user.accessToken,
            true
        );

        assertEquals("minecraft-access-token", report.minecraftAccessToken());
        assertEquals(user.accessToken, report.oauthAccessToken());
        assertEquals(user.refreshToken, report.oauthRefreshToken());
        assertEquals(604800, report.oauthExpire());
        assertEquals("discord-access-token", user.discordAccessToken);
        assertEquals("discord-refresh-token", user.discordRefreshToken);
        assertNotEquals(user.discordAccessToken, report.oauthAccessToken());
        assertNotEquals(user.discordRefreshToken, report.oauthRefreshToken());
    }
}
