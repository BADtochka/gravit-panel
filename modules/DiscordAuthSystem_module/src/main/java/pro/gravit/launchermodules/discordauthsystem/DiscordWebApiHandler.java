package pro.gravit.launchermodules.discordauthsystem;

import io.netty.buffer.Unpooled;
import io.netty.channel.ChannelHandlerContext;
import io.netty.handler.codec.http.*;
import org.apache.logging.log4j.LogManager;
import org.apache.logging.log4j.Logger;
import pro.gravit.launcher.base.ClientPermissions;
import pro.gravit.launcher.base.events.RequestEvent;
import pro.gravit.launcher.base.events.request.AuthRequestEvent;
import pro.gravit.launcher.base.profiles.PlayerProfile;
import pro.gravit.launcher.base.request.auth.password.AuthCodePassword;
import pro.gravit.launchserver.LaunchServer;
import pro.gravit.launchserver.auth.AuthException;
import pro.gravit.launchserver.auth.AuthProviderPair;
import pro.gravit.launchserver.manangers.AuthManager;
import pro.gravit.launchserver.socket.Client;
import pro.gravit.launchserver.socket.NettyConnectContext;
import pro.gravit.launchserver.socket.handlers.NettyWebAPIHandler;
import pro.gravit.launchserver.socket.response.auth.AuthResponse;

import java.io.IOException;
import java.util.Map;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.concurrent.atomic.AtomicReference;

import static io.netty.handler.codec.http.HttpVersion.HTTP_1_1;

public class DiscordWebApiHandler implements NettyWebAPIHandler.SimpleSeverletHandler {
    private final Logger logger = LogManager.getLogger();
    private final LaunchServer server;

    public DiscordWebApiHandler(LaunchServer server) {
        this.server = server;
    }

    @Override
    public void handle(ChannelHandlerContext ctx, FullHttpRequest request, NettyConnectContext context) {
        Map<String, String> params = getParamsFromUri(request.uri());
        String state = params.get("state");
        String code = params.get("code");

        if (state == null || state.isEmpty()) {
            sendHttpResponse(ctx, simpleResponse(HttpResponseStatus.BAD_REQUEST, "Missing 'state' parameter"));
            return;
        }

        AuthProviderPair pair = findDiscordProvider();
        if (pair == null || !(pair.core instanceof DiscordAuthCoreProvider provider)) {
            sendHttpResponse(ctx, simpleResponse(HttpResponseStatus.SERVICE_UNAVAILABLE, "Discord auth provider is not configured"));
            return;
        }

        if (code == null || code.isEmpty()) {
            String authorizeUrl;
            try {
                authorizeUrl = provider.buildAuthorizeUrl(state);
            } catch (IOException e) {
                logger.error("Discord authorization is unavailable", e);
                sendHttpResponse(ctx, simpleResponse(HttpResponseStatus.SERVICE_UNAVAILABLE, "Discord authorization is unavailable"));
                return;
            }
            FullHttpResponse response = new DefaultFullHttpResponse(HTTP_1_1, HttpResponseStatus.FOUND);
            response.headers().set(HttpHeaderNames.LOCATION, authorizeUrl);
            sendHttpResponse(ctx, response);
            return;
        }

        AtomicBoolean stateMatched = new AtomicBoolean(false);
        AtomicReference<Client> matchedClient = new AtomicReference<>();
        server.nettyServerSocketHandler.nettyServer.service.forEachActiveChannels((ch, ws) -> {
            Client client = ws.getClient();
            if (client == null) return;
            if (provider.consumePendingState(state, client)) {
                stateMatched.set(true);
                matchedClient.set(client);
            }
        });

        if (!stateMatched.get()) {
            sendHttpResponse(ctx, simpleResponse(HttpResponseStatus.BAD_REQUEST, "Invalid or expired state"));
            return;
        }

        AuthManager.AuthReport report;
        try {
            report = provider.authorize("", null, new AuthCodePassword(code), true);
        } catch (AuthException e) {
            logger.warn("Discord authorization failed: {}", e.getMessage());
            sendHttpResponse(ctx, simpleHtmlResponse(HttpResponseStatus.FORBIDDEN, "Authorization failed: " + escapeHtml(e.getMessage())));
            return;
        } catch (Exception e) {
            logger.error("Discord authorization error", e);
            sendHttpResponse(ctx, simpleResponse(HttpResponseStatus.INTERNAL_SERVER_ERROR, "Internal error"));
            return;
        }

        DiscordUser user = (DiscordUser) report.session().getUser();
        String minecraftAccessToken = report.minecraftAccessToken();
        AuthRequestEvent.OAuthRequestEvent oauth = new AuthRequestEvent.OAuthRequestEvent(
            report.oauthAccessToken(), report.oauthRefreshToken(), report.oauthExpire()
        );

        server.nettyServerSocketHandler.nettyServer.service.forEachActiveChannels((ch, ws) -> {
            Client client = ws.getClient();
            if (client == null) return;
            if (client != matchedClient.get()) return;

            client.coreObject = user;
            client.sessionObject = report.session();
            server.authManager.internalAuth(client, AuthResponse.ConnectTypes.CLIENT, pair, user.getUsername(), user.getUUID(), ClientPermissions.DEFAULT, true);
            PlayerProfile playerProfile = server.authManager.getPlayerProfile(client);
            AuthRequestEvent event = new AuthRequestEvent(ClientPermissions.DEFAULT, playerProfile, minecraftAccessToken, null, null, oauth);
            event.requestUUID = RequestEvent.eventUUID;
            server.nettyServerSocketHandler.nettyServer.service.sendObject(ch, event);
        });

        sendHttpResponse(ctx, simpleHtmlResponse(HttpResponseStatus.OK, "Authorization successful. You can close this window and return to the launcher."));
    }

    private AuthProviderPair findDiscordProvider() {
        for (var entry : server.config.auth.entrySet()) {
            if (entry.getValue().core instanceof DiscordAuthCoreProvider) {
                return entry.getValue();
            }
        }
        return null;
    }

    private FullHttpResponse simpleHtmlResponse(HttpResponseStatus status, String body) {
        String html = "<!DOCTYPE html><html><head><meta charset='utf-8'></head><body>"
            + escapeHtml(body)
            + "</body></html>";
        FullHttpResponse response = new DefaultFullHttpResponse(HTTP_1_1, status, Unpooled.wrappedBuffer(html.getBytes(java.nio.charset.StandardCharsets.UTF_8)));
        response.headers().set(HttpHeaderNames.CONTENT_TYPE, "text/html; charset=UTF-8");
        return response;
    }

    private static String escapeHtml(String text) {
        return text
            .replace("&", "&amp;")
            .replace("<", "&lt;")
            .replace(">", "&gt;")
            .replace("\"", "&quot;")
            .replace("'", "&#x27;");
    }
}
