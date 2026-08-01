package pro.gravit.launchermodules.discordauthsystem;

import com.google.gson.JsonObject;
import com.google.gson.JsonParser;
import org.junit.jupiter.api.Test;
import pro.gravit.launcher.base.ClientPermissions;

import javax.crypto.Mac;
import javax.crypto.spec.SecretKeySpec;
import java.nio.charset.StandardCharsets;
import java.util.Base64;
import java.util.UUID;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;

class PortalTicketTest {
    @Test
    void signsOnlyTheExpectedIdentityClaims() throws Exception {
        DiscordUser user = new DiscordUser(
            UUID.fromString("aa90f8c5-1214-3f4e-a64c-3afde444097b"),
            "1531370122256711680", "formallybad", ClientPermissions.DEFAULT
        );
        String secret = "0123456789abcdef0123456789abcdef";
        String ticket = PortalTicket.create(user, secret, 1_800_000_000L, "ticket-nonce");
        String[] parts = ticket.split("\\.");

        assertEquals(2, parts.length);
        JsonObject payload = JsonParser.parseString(new String(
            Base64.getUrlDecoder().decode(parts[0]), StandardCharsets.UTF_8
        )).getAsJsonObject();
        assertEquals(user.getUUID().toString(), payload.get("uuid").getAsString());
        assertEquals(user.getUsername(), payload.get("username").getAsString());
        assertEquals(user.getDiscordId(), payload.get("discordId").getAsString());
        assertEquals(1_800_000_000L, payload.get("exp").getAsLong());
        assertEquals("ticket-nonce", payload.get("nonce").getAsString());
        assertFalse(payload.has("accessToken"));
        assertFalse(payload.has("refreshToken"));
        assertEquals(hmac(parts[0], secret), parts[1]);
    }

    private static String hmac(String payload, String secret) throws Exception {
        Mac mac = Mac.getInstance("HmacSHA256");
        mac.init(new SecretKeySpec(secret.getBytes(StandardCharsets.UTF_8), "HmacSHA256"));
        return Base64.getUrlEncoder().withoutPadding().encodeToString(
            mac.doFinal(payload.getBytes(StandardCharsets.US_ASCII))
        );
    }
}
