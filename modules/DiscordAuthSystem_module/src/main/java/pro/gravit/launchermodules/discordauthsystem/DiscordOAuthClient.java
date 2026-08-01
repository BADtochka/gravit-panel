package pro.gravit.launchermodules.discordauthsystem;

import com.google.gson.Gson;
import com.google.gson.JsonObject;
import com.google.gson.JsonParser;

import java.io.IOException;
import java.net.URI;
import java.net.URLEncoder;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.nio.charset.StandardCharsets;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.stream.Collectors;

public class DiscordOAuthClient {
    private final HttpClient httpClient = HttpClient.newHttpClient();
    private final DiscordAuthSystemConfig config;
    private final Gson gson = new Gson();

    public DiscordOAuthClient(DiscordAuthSystemConfig config) {
        this.config = config;
    }

    public String buildAuthorizeUrl(String state) {
        return buildAuthorizeUrl(state, config.redirectUrl);
    }

    public String buildAuthorizeUrl(String state, String redirectUrl) {
        String scope = "identify guilds";
        return config.discordAuthorizeUrl
            + "?client_id=" + urlEncode(config.clientId)
            + "&redirect_uri=" + urlEncode(redirectUrl)
            + "&response_type=code"
            + "&scope=" + urlEncode(scope)
            + "&state=" + urlEncode(state);
    }

    public TokenResponse exchangeCode(String code) throws IOException {
        return exchangeCode(code, config.redirectUrl);
    }

    public TokenResponse exchangeCode(String code, String redirectUrl) throws IOException {
        Map<String, String> params = new HashMap<>();
        params.put("client_id", config.clientId);
        params.put("client_secret", config.clientSecret);
        params.put("grant_type", "authorization_code");
        params.put("code", code);
        params.put("redirect_uri", redirectUrl);
        return exchangeToken(params);
    }

    public TokenResponse refreshAccessToken(String refreshToken) throws IOException {
        Map<String, String> params = new HashMap<>();
        params.put("client_id", config.clientId);
        params.put("client_secret", config.clientSecret);
        params.put("grant_type", "refresh_token");
        params.put("refresh_token", refreshToken);
        return exchangeToken(params);
    }

    private TokenResponse exchangeToken(Map<String, String> params) throws IOException {
        String body = params.entrySet().stream()
            .map(e -> urlEncode(e.getKey()) + "=" + urlEncode(e.getValue()))
            .collect(Collectors.joining("&"));

        HttpRequest request = HttpRequest.newBuilder()
            .uri(URI.create(config.discordTokenUrl))
            .header("Content-Type", "application/x-www-form-urlencoded")
            .POST(HttpRequest.BodyPublishers.ofString(body))
            .build();

        HttpResponse<String> response = send(request);
        JsonObject json = JsonParser.parseString(response.body()).getAsJsonObject();
        if (json.has("error")) {
            throw new IOException("Discord token request failed: " + json.get("error").getAsString());
        }
        return new TokenResponse(
            getString(json, "access_token"),
            getString(json, "refresh_token"),
            json.has("expires_in") ? json.get("expires_in").getAsLong() : 0
        );
    }

    public DiscordUserInfo fetchUserInfo(String accessToken) throws IOException {
        HttpRequest request = HttpRequest.newBuilder()
            .uri(URI.create(config.discordApiEndpoint + "/users/@me"))
            .header("Authorization", "Bearer " + accessToken)
            .GET()
            .build();

        HttpResponse<String> response = send(request);
        JsonObject json = JsonParser.parseString(response.body()).getAsJsonObject();
        return new DiscordUserInfo(
            getString(json, "id"),
            getString(json, "username"),
            getString(json, "global_name"),
            getString(json, "discriminator")
        );
    }

    public List<GuildMember> fetchGuildMembers(String accessToken) throws IOException {
        HttpRequest request = HttpRequest.newBuilder()
            .uri(URI.create(config.discordApiEndpoint + "/users/@me/guilds"))
            .header("Authorization", "Bearer " + accessToken)
            .GET()
            .build();

        HttpResponse<String> response = send(request);
        return gson.fromJson(response.body(), GUILD_LIST_TYPE);
    }

    public GuildMember fetchGuildMember(String guildId, String userId, String accessToken) throws IOException {
        HttpRequest request = HttpRequest.newBuilder()
            .uri(URI.create(config.discordApiEndpoint + "/users/@me/guilds/" + guildId + "/member"))
            .header("Authorization", "Bearer " + accessToken)
            .GET()
            .build();

        HttpResponse<String> response = send(request);
        if (response.statusCode() == 200) {
            return gson.fromJson(response.body(), GuildMember.class);
        }
        return null;
    }

    private HttpResponse<String> send(HttpRequest request) throws IOException {
        try {
            HttpResponse<String> response = httpClient.send(request, HttpResponse.BodyHandlers.ofString(StandardCharsets.UTF_8));
            if (response.statusCode() < 200 || response.statusCode() >= 300) {
                throw new IOException("Discord API returned " + response.statusCode() + ": " + response.body());
            }
            return response;
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
            throw new IOException("Discord API request interrupted", e);
        }
    }

    private static String urlEncode(String value) {
        return URLEncoder.encode(value, StandardCharsets.UTF_8);
    }

    private static String getString(JsonObject json, String key) {
        return json.has(key) && !json.get(key).isJsonNull() ? json.get(key).getAsString() : "";
    }

    public static class TokenResponse {
        public final String accessToken;
        public final String refreshToken;
        public final long expiresIn;

        public TokenResponse(String accessToken, String refreshToken, long expiresIn) {
            this.accessToken = accessToken;
            this.refreshToken = refreshToken;
            this.expiresIn = expiresIn;
        }
    }

    public static class DiscordUserInfo {
        public final String id;
        public final String username;
        public final String globalName;
        public final String discriminator;

        public DiscordUserInfo(String id, String username, String globalName, String discriminator) {
            this.id = id;
            this.username = username;
            this.globalName = globalName;
            this.discriminator = discriminator;
        }

        public String displayName() {
            if (globalName != null && !globalName.isEmpty()) {
                return globalName;
            }
            if (discriminator != null && !discriminator.isEmpty() && !"0".equals(discriminator)) {
                return username + "#" + discriminator;
            }
            return username;
        }

        public DiscordUserInfo withUsername(String username) {
            return new DiscordUserInfo(id, username, globalName, discriminator);
        }
    }

    public static class GuildMember {
        public String id;
        public String nick;
        public boolean pending;
    }

    private static final java.lang.reflect.Type GUILD_LIST_TYPE = new com.google.gson.reflect.TypeToken<List<GuildMember>>() {}.getType();
}
