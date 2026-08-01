package pro.gravit.launchermodules.discordauthsystem;

import com.google.gson.Gson;
import pro.gravit.launcher.base.ClientPermissions;
import pro.gravit.launcher.base.events.request.GetAvailabilityAuthRequestEvent;
import pro.gravit.launcher.base.request.auth.password.AuthCodePassword;
import pro.gravit.launcher.base.request.auth.password.AuthPlainPassword;
import pro.gravit.launcher.base.request.auth.details.AuthWebViewDetails;
import pro.gravit.launchserver.LaunchServer;
import pro.gravit.launchserver.auth.AuthException;
import pro.gravit.launchserver.auth.AuthProviderPair;
import pro.gravit.launchserver.auth.core.AuthCoreProvider;
import pro.gravit.launchserver.auth.core.User;
import pro.gravit.launchserver.auth.core.UserSession;
import pro.gravit.launchserver.manangers.AuthManager;
import pro.gravit.launchserver.socket.Client;
import pro.gravit.launchserver.socket.response.auth.AuthResponse;
import pro.gravit.utils.helper.LogHelper;
import pro.gravit.utils.helper.SecurityHelper;

import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.net.URI;
import java.util.Map;
import java.util.UUID;
import java.util.List;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.ConcurrentMap;

public class DiscordAuthCoreProvider extends AuthCoreProvider {
    private static final long PENDING_STATE_TTL_MS = 10 * 60 * 1000L;
    private static final long COMPLETED_AUTH_TTL_MS = 2 * 60 * 1000L;
    private static final int MAX_PENDING_STATES_PER_CLIENT = 5;
    // These are runtime services initialized by the module after LaunchServer
    // has deserialized the core config. Gson must never persist them into
    // LaunchServer.json: Gson and HttpClient contain JDK-internal state.
    private transient DiscordAuthSystemConfig config;
    private transient JsonUserStorage storage;
    private transient DiscordOAuthClient oauthClient;

    private transient final ConcurrentMap<String, PendingAuthState> pendingStates = new ConcurrentHashMap<>();
    private transient final ConcurrentMap<String, PendingPortalState> pendingPortalStates = new ConcurrentHashMap<>();
    private transient final ConcurrentMap<Client, CompletedAuth> completedAuth = new ConcurrentHashMap<>();

    @Override
    public void init(LaunchServer server, AuthProviderPair pair) {
        super.init(server, pair);
        // LaunchServer creates auth cores before LaunchServerFullInitEvent. The
        // module fills DiscordAuthSystemContext during that later event, so do
        // not snapshot its null fields here.
    }

    @Override
    public List<GetAvailabilityAuthRequestEvent.AuthAvailabilityDetails> getDetails(Client client) {
        try {
            ensureInitialized();
        } catch (IOException e) {
            throw new IllegalStateException(e.getMessage(), e);
        }
        String state = createPendingState(client);
        return List.of(new AuthWebViewDetails(oauthClient.buildAuthorizeUrl(state), config.redirectUrl));
    }

    public String buildAuthorizeUrl(String state) throws IOException {
        ensureInitialized();
        return oauthClient.buildAuthorizeUrl(state);
    }

    public String startPortalAuthorization() throws IOException {
        ensureInitialized();
        validatePortalConfiguration();
        cleanupExpiredStates();
        if (pendingPortalStates.size() >= 10_000) {
            throw new IOException("Too many pending portal authorizations");
        }
        String state = SecurityHelper.randomStringToken();
        pendingPortalStates.put(state, new PendingPortalState());
        return oauthClient.buildAuthorizeUrl(state, config.portalRedirectUrl);
    }

    public DiscordUser completePortalAuthorization(String state, String code) throws IOException {
        ensureInitialized();
        validatePortalConfiguration();
        cleanupExpiredStates();
        PendingPortalState pending = pendingPortalStates.remove(state);
        if (pending == null) {
            throw new AuthException("Portal authorization link expired");
        }
        if (code == null || code.isBlank()) {
            throw new AuthException("Discord did not return an authorization code");
        }
        return authenticateDiscord(code, config.portalRedirectUrl);
    }

    public String createPortalTicket(DiscordUser user) throws IOException {
        ensureInitialized();
        validatePortalConfiguration();
        long expiresAt = (System.currentTimeMillis() / 1000L) + config.portalTicketTtlSeconds;
        return PortalTicket.create(user, config.portalHmacSecret, expiresAt, SecurityHelper.randomStringToken());
    }

    public boolean consumePendingState(String state, Client client) {
        cleanupExpiredStates();
        PendingAuthState pending = pendingStates.get(state);
        return pending != null &&
            pending.client == client &&
            pendingStates.remove(state, pending);
    }

    private void refreshRuntimeServices() throws IOException {
        if (config != null && storage != null && oauthClient != null) {
            return;
        }
        this.config = DiscordAuthSystemContext.config;
        this.storage = DiscordAuthSystemContext.storage;
        this.oauthClient = DiscordAuthSystemContext.oauthClient;
        if (config != null && storage != null && oauthClient != null) {
            return;
        }
        if (server == null) {
            return;
        }

        Path moduleConfig = server.dir.resolve("config").resolve("DiscordAuthSystem").resolve("Config.json");
        if (!Files.isRegularFile(moduleConfig)) {
            return;
        }
        DiscordAuthSystemConfig loadedConfig = new Gson().fromJson(
            Files.readString(moduleConfig), DiscordAuthSystemConfig.class
        );
        if (loadedConfig == null) {
            return;
        }
        this.config = loadedConfig;
        this.storage = new JsonUserStorage(server);
        this.oauthClient = new DiscordOAuthClient(loadedConfig);
    }

    public String createPendingState(Client client) {
        cleanupExpiredStates();
        trimPendingStates(client);
        completedAuth.remove(client);
        String state = SecurityHelper.randomStringToken();
        pendingStates.put(state, new PendingAuthState(client));
        return state;
    }

    public void completeBrowserAuthorization(Client client, AuthManager.AuthReport report) {
        cleanupExpiredStates();
        pendingStates.entrySet().removeIf((entry) -> entry.getValue().client == client);
        completedAuth.put(client, new CompletedAuth(report));
    }

    private void trimPendingStates(Client client) {
        while (pendingStates.values().stream().filter((pending) -> pending.client == client).count()
            >= MAX_PENDING_STATES_PER_CLIENT) {
            Map.Entry<String, PendingAuthState> oldest = null;
            for (Map.Entry<String, PendingAuthState> entry : pendingStates.entrySet()) {
                PendingAuthState pending = entry.getValue();
                if (
                    pending.client == client &&
                    (oldest == null || pending.createdAt < oldest.getValue().createdAt)
                ) {
                    oldest = entry;
                }
            }
            if (oldest == null || !pendingStates.remove(oldest.getKey(), oldest.getValue())) {
                return;
            }
        }
    }

    private AuthManager.AuthReport consumeBrowserAuthorization(Client client) {
        cleanupExpiredStates();
        CompletedAuth completed = completedAuth.remove(client);
        return completed == null ? null : completed.report;
    }

    private void cleanupExpiredStates() {
        long now = System.currentTimeMillis();
        pendingStates.entrySet().removeIf((entry) ->
            now - entry.getValue().createdAt > PENDING_STATE_TTL_MS
        );
        completedAuth.entrySet().removeIf((entry) ->
            now - entry.getValue().createdAt > COMPLETED_AUTH_TTL_MS
        );
        pendingPortalStates.entrySet().removeIf((entry) ->
            now - entry.getValue().createdAt > PENDING_STATE_TTL_MS
        );
    }

    private void ensureInitialized() throws IOException {
        refreshRuntimeServices();
        if (config == null || storage == null || oauthClient == null) {
            throw new IOException("DiscordAuthSystem module is not initialized");
        }
    }

    @Override
    public User getUserByUsername(String username) {
        return storage == null ? null : storage.findByUsername(username);
    }

    @Override
    public User getUserByUUID(UUID uuid) {
        return storage == null ? null : storage.findByUuid(uuid);
    }

    @Override
    public UserSession getUserSessionByOAuthAccessToken(String accessToken) {
        try {
            ensureInitialized();
        } catch (IOException e) {
            LogHelper.error("Unable to initialize DiscordAuthSystem for session restore", e);
            return null;
        }
        DiscordUser user = storage.findByAccessToken(accessToken);
        return user == null ? null : new DiscordUserSession(user, accessToken);
    }

    @Override
    public AuthManager.AuthReport refreshAccessToken(String refreshToken, AuthResponse.AuthContext context) {
        try {
            ensureInitialized();
            DiscordUser user = storage.findByRefreshToken(refreshToken);
            if (
                user == null ||
                user.discordRefreshToken == null ||
                user.discordRefreshToken.isBlank()
            ) {
                return null;
            }
            DiscordOAuthClient.TokenResponse tokens =
                oauthClient.refreshAccessToken(user.discordRefreshToken);
            if (tokens.accessToken == null || tokens.accessToken.isBlank()) {
                return null;
            }
            String nextRefreshToken =
                tokens.refreshToken == null || tokens.refreshToken.isBlank()
                    ? user.discordRefreshToken
                    : tokens.refreshToken;
            long expireIn = tokens.expiresIn > 0 ? tokens.expiresIn : 0;
            user.updateOAuth(tokens.accessToken, nextRefreshToken, expireIn);
            storage.save();
            return reportFor(user, user.accessToken, false);
        } catch (IOException e) {
            LogHelper.error("Unable to refresh Discord OAuth access token", e);
            return null;
        }
    }

    @Override
    public AuthManager.AuthReport authorize(String login, AuthResponse.AuthContext context, pro.gravit.launcher.base.request.auth.AuthRequest.AuthPasswordInterface password, boolean minecraftAccess) throws IOException {
        ensureInitialized();
        if (password instanceof AuthCodePassword codePassword) {
            if (codePassword.uri == null || codePassword.uri.isBlank()) {
                if (context == null || context.client == null) {
                    throw new AuthException("Discord browser authorization requires a launcher connection");
                }
                AuthManager.AuthReport completed = consumeBrowserAuthorization(context.client);
                if (completed == null) {
                    throw new AuthException("Complete Discord authorization in your browser first");
                }
                return completed;
            }
            return authorizeByCode(codePassword.uri, minecraftAccess);
        }
        if (password instanceof AuthPlainPassword plainPassword && "sudo".equals(plainPassword.password)) {
            DiscordUser user = storage.findByUsername(login);
            if (user != null) {
                String accessToken = SecurityHelper.randomStringToken();
                return reportFor(user, accessToken, minecraftAccess);
            }
        }
        throw AuthException.userNotFound();
    }

    private AuthManager.AuthReport authorizeByCode(String code, boolean minecraftAccess) throws IOException {
        DiscordUser user = authenticateDiscord(code, config.redirectUrl);
        return reportFor(user, user.accessToken, minecraftAccess);
    }

    private DiscordUser authenticateDiscord(String code, String redirectUrl) throws IOException {
        DiscordOAuthClient.TokenResponse tokens = oauthClient.exchangeCode(code, redirectUrl);
        DiscordOAuthClient.DiscordUserInfo userInfo = oauthClient.fetchUserInfo(tokens.accessToken);

        if (userInfo.id == null || userInfo.id.isEmpty()) {
            throw AuthException.userNotFound();
        }

        if (!config.requiredGuildIds.isEmpty()) {
            GuildChecker.GuildResult guildResult = new GuildChecker(oauthClient, config).checkGuilds(userInfo.id, tokens.accessToken);
            if (!guildResult.allowed()) {
                throw new AuthException("User is not a member of required Discord guilds");
            }
            if (!config.useGlobalNickname && guildResult.nickname() != null && !guildResult.nickname().isEmpty()) {
                userInfo = userInfo.withUsername(guildResult.nickname());
            }
        }

        String formattedUsername = NicknameFormatter.format(userInfo.displayName(), config);
        if (formattedUsername == null || formattedUsername.isEmpty()) {
            throw new AuthException("Username does not match configured format");
        }

        DiscordUser user = storage.findByDiscordId(userInfo.id);
        if (user == null) {
            if (!config.autoRegister) {
                throw AuthException.userNotFound();
            }
            user = storage.createUser(userInfo.id, formattedUsername, ClientPermissions.DEFAULT);
        }

        String accessToken = tokens.accessToken != null ? tokens.accessToken : SecurityHelper.randomStringToken();
        String refreshToken = tokens.refreshToken != null ? tokens.refreshToken : "";
        long expireIn = tokens.expiresIn > 0 ? tokens.expiresIn : 0;

        user.updateOAuth(accessToken, refreshToken, expireIn);
        storage.save();

        return user;
    }

    private void validatePortalConfiguration() throws IOException {
        if (config.portalRedirectUrl == null || config.portalRedirectUrl.isBlank() ||
            config.portalCallbackUrl == null || config.portalCallbackUrl.isBlank()) {
            throw new IOException("Portal OAuth is not configured");
        }
        validateHttpUrl(config.portalRedirectUrl, "portalRedirectUrl");
        validateHttpUrl(config.portalCallbackUrl, "portalCallbackUrl");
        if (config.portalHmacSecret == null ||
            config.portalHmacSecret.getBytes(java.nio.charset.StandardCharsets.UTF_8).length < 32) {
            throw new IOException("portalHmacSecret must contain at least 32 bytes");
        }
        if (config.portalTicketTtlSeconds < 30 || config.portalTicketTtlSeconds > 300) {
            throw new IOException("portalTicketTtlSeconds must be between 30 and 300");
        }
    }

    private static void validateHttpUrl(String value, String field) throws IOException {
        try {
            URI uri = URI.create(value);
            if ((!("https".equalsIgnoreCase(uri.getScheme())) && !("http".equalsIgnoreCase(uri.getScheme()))) ||
                uri.getHost() == null || uri.getUserInfo() != null) {
                throw new IOException(field + " must be an absolute HTTP(S) URL without user info");
            }
        } catch (IllegalArgumentException e) {
            throw new IOException(field + " must be a valid URL", e);
        }
    }

    static AuthManager.AuthReport reportFor(DiscordUser user, String accessToken, boolean minecraftAccess) {
        DiscordUserSession session = new DiscordUserSession(user, accessToken);
        if (minecraftAccess) {
            return AuthManager.AuthReport.ofOAuthWithMinecraft(
                user.minecraftAccessToken,
                accessToken,
                user.refreshToken,
                user.expireIn,
                session
            );
        }
        return AuthManager.AuthReport.ofOAuth(accessToken, user.refreshToken, user.expireIn, session);
    }

    @Override
    public User checkServer(Client client, String username, String serverID) throws IOException {
        return getUserByUsername(username);
    }

    @Override
    public boolean joinServer(Client client, String username, UUID uuid, String accessToken, String serverID) throws IOException {
        if (storage == null) return false;
        DiscordUser user = username == null || username.isBlank()
            ? storage.findByUuid(uuid)
            : storage.findByUsername(username);
        return user != null && (accessToken == null || accessToken.equals(user.accessToken) || accessToken.equals(user.minecraftAccessToken));
    }

    @Override
    public void close() {
        pendingStates.clear();
        pendingPortalStates.clear();
        completedAuth.clear();
        if (storage != null) {
            storage.save();
        }
    }

    public DiscordAuthSystemConfig getConfig() {
        return config;
    }

    public static class PendingAuthState {
        public final Client client;
        public final long createdAt;

        public PendingAuthState(Client client) {
            this.client = client;
            this.createdAt = System.currentTimeMillis();
        }
    }

    private static class PendingPortalState {
        public final long createdAt = System.currentTimeMillis();
    }

    private static class CompletedAuth {
        public final AuthManager.AuthReport report;
        public final long createdAt;

        public CompletedAuth(AuthManager.AuthReport report) {
            this.report = report;
            this.createdAt = System.currentTimeMillis();
        }
    }
}
