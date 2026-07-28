package pro.gravit.launchermodules.discordauthsystem;

import com.google.gson.Gson;
import com.google.gson.GsonBuilder;
import com.google.gson.reflect.TypeToken;
import pro.gravit.launcher.base.ClientPermissions;
import pro.gravit.launchserver.LaunchServer;
import pro.gravit.utils.helper.IOHelper;
import pro.gravit.utils.helper.LogHelper;

import java.io.IOException;
import java.io.Reader;
import java.io.Writer;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.Map;
import java.util.UUID;
import java.util.concurrent.ConcurrentHashMap;

public class JsonUserStorage {
    private final Gson gson = new GsonBuilder().setPrettyPrinting().create();
    private final Path storagePath;

    private final Map<String, DiscordUser> byDiscordId = new ConcurrentHashMap<>();
    private final Map<String, DiscordUser> byUsername = new ConcurrentHashMap<>();
    private final Map<UUID, DiscordUser> byUuid = new ConcurrentHashMap<>();

    public JsonUserStorage(LaunchServer server) {
        this(server.dir.resolve("config").resolve("DiscordAuthSystem").resolve("Database.json"));
    }

    JsonUserStorage(Path storagePath) {
        this.storagePath = storagePath;
        load();
    }

    public synchronized void load() {
        byDiscordId.clear();
        byUsername.clear();
        byUuid.clear();
        if (!Files.exists(storagePath)) {
            return;
        }
        try (Reader reader = Files.newBufferedReader(storagePath, StandardCharsets.UTF_8)) {
            Map<String, StoredUser> stored = gson.fromJson(reader, new TypeToken<Map<String, StoredUser>>() {}.getType());
            if (stored == null) return;
            for (StoredUser su : stored.values()) {
                DiscordUser user = new DiscordUser(su.uuid, su.discordId, su.username, su.permissions);
                if (su.discordAccessToken == null) {
                    // 1.0.5 and older stored Discord provider credentials in
                    // the launcher session-token fields. Keep those provider
                    // credentials server-side and invalidate the leaked client
                    // session by generating fresh local tokens.
                    user.discordAccessToken = su.accessToken;
                    user.discordRefreshToken = su.refreshToken;
                    user.discordExpireIn = su.expireIn;
                    user.accessToken = pro.gravit.utils.helper.SecurityHelper.randomStringToken();
                    user.refreshToken = pro.gravit.utils.helper.SecurityHelper.randomStringToken();
                } else {
                    user.accessToken = su.accessToken;
                    user.refreshToken = su.refreshToken;
                    user.discordAccessToken = su.discordAccessToken;
                    user.discordRefreshToken = su.discordRefreshToken;
                    user.discordExpireIn = su.discordExpireIn;
                }
                user.expireIn = su.expireIn;
                user.minecraftAccessToken = su.minecraftAccessToken != null ? su.minecraftAccessToken : java.util.UUID.randomUUID().toString().replace("-", "");
                user.setBanned(su.banned);
                index(user);
            }
        } catch (IOException e) {
            LogHelper.error("Unable to load DiscordAuthSystem database", e);
        }
    }

    public synchronized void save() {
        try {
            Files.createDirectories(storagePath.getParent());
            Map<String, StoredUser> stored = new ConcurrentHashMap<>();
            for (DiscordUser user : byDiscordId.values()) {
                StoredUser su = new StoredUser();
                su.uuid = user.getUUID();
                su.discordId = user.getDiscordId();
                su.username = user.getUsername();
                su.permissions = user.getPermissions();
                su.accessToken = user.accessToken;
                su.refreshToken = user.refreshToken;
                su.expireIn = user.expireIn;
                su.discordAccessToken = user.discordAccessToken;
                su.discordRefreshToken = user.discordRefreshToken;
                su.discordExpireIn = user.discordExpireIn;
                su.minecraftAccessToken = user.minecraftAccessToken;
                su.banned = user.isBanned();
                stored.put(user.getDiscordId(), su);
            }
            try (Writer writer = Files.newBufferedWriter(storagePath, StandardCharsets.UTF_8)) {
                gson.toJson(stored, writer);
            }
        } catch (IOException e) {
            LogHelper.error("Unable to save DiscordAuthSystem database", e);
        }
    }

    public synchronized DiscordUser findByDiscordId(String discordId) {
        return byDiscordId.get(discordId);
    }

    public synchronized DiscordUser findByUsername(String username) {
        if (username == null || username.isBlank()) {
            return null;
        }
        return byUsername.get(username.toLowerCase());
    }

    public synchronized DiscordUser findByUuid(UUID uuid) {
        if (uuid == null) {
            return null;
        }
        return byUuid.get(uuid);
    }

    public synchronized DiscordUser findByAccessToken(String accessToken) {
        for (DiscordUser user : byDiscordId.values()) {
            if (accessToken != null && accessToken.equals(user.accessToken)) {
                return user;
            }
        }
        return null;
    }

    public synchronized DiscordUser findByRefreshToken(String refreshToken) {
        for (DiscordUser user : byDiscordId.values()) {
            if (refreshToken != null && refreshToken.equals(user.refreshToken)) {
                return user;
            }
        }
        return null;
    }

    public synchronized DiscordUser createUser(String discordId, String username, ClientPermissions permissions) {
        UUID uuid = UUID.nameUUIDFromBytes(("discord:" + discordId).getBytes(StandardCharsets.UTF_8));
        if (byUsername.containsKey(username.toLowerCase())) {
            int suffix = 1;
            String base = username;
            do {
                username = base + suffix;
                suffix++;
            } while (byUsername.containsKey(username.toLowerCase()));
        }
        DiscordUser user = new DiscordUser(uuid, discordId, username, permissions);
        index(user);
        save();
        return user;
    }

    private void index(DiscordUser user) {
        byDiscordId.put(user.getDiscordId(), user);
        byUsername.put(user.getUsername().toLowerCase(), user);
        byUuid.put(user.getUUID(), user);
    }

    public static class StoredUser {
        public UUID uuid;
        public String discordId;
        public String username;
        public ClientPermissions permissions;
        public String accessToken;
        public String refreshToken;
        public long expireIn;
        public String discordAccessToken;
        public String discordRefreshToken;
        public long discordExpireIn;
        public String minecraftAccessToken;
        public boolean banned;
    }
}
