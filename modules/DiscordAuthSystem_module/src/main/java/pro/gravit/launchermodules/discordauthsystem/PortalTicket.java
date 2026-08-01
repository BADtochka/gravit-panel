package pro.gravit.launchermodules.discordauthsystem;

import com.google.gson.JsonObject;

import javax.crypto.Mac;
import javax.crypto.spec.SecretKeySpec;
import java.nio.charset.StandardCharsets;
import java.util.Base64;

final class PortalTicket {
    private PortalTicket() {
    }

    static String create(DiscordUser user, String secret, long expiresAtSeconds, String nonce) {
        JsonObject payload = new JsonObject();
        payload.addProperty("uuid", user.getUUID().toString());
        payload.addProperty("username", user.getUsername());
        payload.addProperty("discordId", user.getDiscordId());
        payload.addProperty("exp", expiresAtSeconds);
        payload.addProperty("nonce", nonce);
        String encodedPayload = Base64.getUrlEncoder().withoutPadding().encodeToString(
            payload.toString().getBytes(StandardCharsets.UTF_8)
        );
        return encodedPayload + "." + sign(encodedPayload, secret);
    }

    static String sign(String encodedPayload, String secret) {
        try {
            Mac mac = Mac.getInstance("HmacSHA256");
            mac.init(new SecretKeySpec(secret.getBytes(StandardCharsets.UTF_8), "HmacSHA256"));
            return Base64.getUrlEncoder().withoutPadding().encodeToString(
                mac.doFinal(encodedPayload.getBytes(StandardCharsets.US_ASCII))
            );
        } catch (Exception e) {
            throw new IllegalStateException("Unable to sign portal ticket", e);
        }
    }
}
