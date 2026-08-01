package pro.gravit.launchermodules.discordauthsystem;

import org.junit.jupiter.api.Test;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertTrue;

class DiscordPortalWebApiHandlerTest {
    @Test
    void usesTheExternallyVisiblePrefixedCallbackPathForTheStateCookie() {
        String redirectUrl = "https://panel.example.com/launcher/webapi/auth/discord/portal";

        assertEquals(
            "/launcher/webapi/auth/discord/portal",
            DiscordPortalWebApiHandler.cookiePath(redirectUrl)
        );
        assertTrue(
            DiscordPortalWebApiHandler.stateCookie("state", redirectUrl)
                .contains("Path=/launcher/webapi/auth/discord/portal")
        );
    }
}
