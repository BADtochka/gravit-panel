package pro.gravit.launchermodules.discordauthsystem;

import org.junit.jupiter.api.Test;
import pro.gravit.launcher.base.ClientPermissions;
import pro.gravit.launchserver.socket.Client;

import java.util.UUID;
import java.util.Map;
import org.junit.jupiter.api.io.TempDir;
import java.nio.file.Path;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNotEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertSame;
import static org.junit.jupiter.api.Assertions.assertTrue;

class DiscordAuthCoreProviderTest {
    @TempDir
    Path temporaryDirectory;

    @Test
    void reusesAuthorizationLinkWhenLauncherRequestsAvailabilityAgain() {
        DiscordAuthCoreProvider provider = new DiscordAuthCoreProvider();
        Client client = new Client();

        String firstState = provider.createPendingState(client);
        String secondState = provider.createPendingState(client);

        assertEquals(firstState, secondState);
        assertTrue(provider.consumePendingState(firstState, client));
        assertFalse(provider.consumePendingState(secondState, client));
    }

    @Test
    void availabilityRefreshDoesNotDiscardCompletedBrowserAuthorization() throws Exception {
        DiscordAuthCoreProvider provider = new DiscordAuthCoreProvider();
        Client client = new Client();
        DiscordUser user = new DiscordUser(
            UUID.fromString("aa90f8c5-1214-3f4e-a64c-3afde444097b"),
            "1531370122256711680",
            "formallybad",
            ClientPermissions.DEFAULT
        );
        provider.completeBrowserAuthorization(client, DiscordAuthCoreProvider.reportFor(user, "token", true));

        provider.createPendingState(client);

        var completedField = DiscordAuthCoreProvider.class.getDeclaredField("completedAuth");
        completedField.setAccessible(true);
        Map<?, ?> completed = (Map<?, ?>) completedField.get(provider);
        assertTrue(completed.containsKey(client));
    }

    @Test
    void completedAuthorizationSurvivesLaunchServerReplacingClientOnLogout() throws Exception {
        DiscordAuthCoreProvider provider = new DiscordAuthCoreProvider();
        Client clientBeforeLogout = new Client();
        String state = provider.createPendingState(clientBeforeLogout);
        DiscordUser user = new DiscordUser(
            UUID.fromString("aa90f8c5-1214-3f4e-a64c-3afde444097b"),
            "1531370122256711680",
            "formallybad",
            ClientPermissions.DEFAULT
        );
        var report = DiscordAuthCoreProvider.reportFor(user, "token", true);

        provider.completeBrowserAuthorization(state, report);
        Client clientAfterLogout = new Client();

        assertNotEquals(clientBeforeLogout, clientAfterLogout);
        assertSame(report, provider.consumeBrowserAuthorizationState(state));
        assertNull(provider.consumeBrowserAuthorizationState(state));
    }

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

    @Test
    void supportsUuidOnlyJoinServerRequestsWithoutDereferencingANullUsername() throws Exception {
        JsonUserStorage storage = new JsonUserStorage(temporaryDirectory.resolve("Database.json"));
        DiscordUser user = storage.createUser(
            "1531370122256711680",
            "formallybad",
            ClientPermissions.DEFAULT
        );
        DiscordAuthCoreProvider provider = new DiscordAuthCoreProvider();
        var storageField = DiscordAuthCoreProvider.class.getDeclaredField("storage");
        storageField.setAccessible(true);
        storageField.set(provider, storage);

        assertNull(storage.findByUsername(null));
        assertNull(storage.findByUsername(""));
        assertNull(storage.findByUuid(null));
        assertSame(user, storage.findByUuid(user.getUUID()));
        assertEquals(
            true,
            provider.joinServer(
                null,
                null,
                user.getUUID(),
                user.minecraftAccessToken,
                "server-id"
            )
        );
    }
}
