package pro.gravit.launchermodules.discordauthsystem;

import io.netty.channel.ChannelHandlerContext;
import io.netty.handler.codec.http.DefaultFullHttpResponse;
import io.netty.handler.codec.http.FullHttpRequest;
import io.netty.handler.codec.http.FullHttpResponse;
import io.netty.handler.codec.http.HttpHeaderNames;
import io.netty.handler.codec.http.HttpResponseStatus;
import io.netty.handler.codec.http.cookie.Cookie;
import io.netty.handler.codec.http.cookie.ServerCookieDecoder;
import org.apache.logging.log4j.LogManager;
import org.apache.logging.log4j.Logger;
import pro.gravit.launchserver.LaunchServer;
import pro.gravit.launchserver.auth.AuthException;
import pro.gravit.launchserver.auth.AuthProviderPair;
import pro.gravit.launchserver.socket.NettyConnectContext;
import pro.gravit.launchserver.socket.handlers.NettyWebAPIHandler;

import java.io.IOException;
import java.net.URI;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.util.Map;

import static io.netty.handler.codec.http.HttpVersion.HTTP_1_1;

/** Browser-only OAuth endpoint for the panel. It never returns Discord credentials. */
public class DiscordPortalWebApiHandler implements NettyWebAPIHandler.SimpleSeverletHandler {
    private static final String STATE_COOKIE = "discord_portal_state";
    private final Logger logger = LogManager.getLogger();
    private final LaunchServer server;

    public DiscordPortalWebApiHandler(LaunchServer server) {
        this.server = server;
    }

    @Override
    public void handle(ChannelHandlerContext ctx, FullHttpRequest request, NettyConnectContext context) {
        DiscordAuthCoreProvider provider = findDiscordProvider();
        if (provider == null) {
            sendHttpResponse(ctx, response(HttpResponseStatus.SERVICE_UNAVAILABLE, null, "Discord auth provider is not configured"));
            return;
        }
        Map<String, String> params = getParamsFromUri(request.uri());
        String state = params.get("state");
        String code = params.get("code");
        try {
            if (state == null || state.isBlank()) {
                String authorizeUrl = provider.startPortalAuthorization();
                String generatedState = getParamsFromUri(authorizeUrl).get("state");
                FullHttpResponse response = redirect(authorizeUrl);
                response.headers().add(HttpHeaderNames.SET_COOKIE, stateCookie(generatedState, provider.getConfig().portalRedirectUrl));
                sendHttpResponse(ctx, response);
                return;
            }
            if (!hasMatchingStateCookie(request, state)) {
                sendHttpResponse(ctx, response(HttpResponseStatus.FORBIDDEN, null, "Discord authorization state is invalid"));
                return;
            }
            DiscordUser user = provider.completePortalAuthorization(state, code);
            String ticket = provider.createPortalTicket(user);
            FullHttpResponse response = redirect(appendTicket(provider.getConfig().portalCallbackUrl, ticket));
            expireStateCookie(response, provider.getConfig().portalRedirectUrl);
            sendHttpResponse(ctx, response);
        } catch (AuthException e) {
            logger.warn("Portal Discord authorization failed: {}", e.getMessage());
            sendHttpResponse(ctx, response(HttpResponseStatus.FORBIDDEN, null, "Discord authorization failed"));
        } catch (IOException e) {
            logger.warn("Portal Discord authorization is unavailable: {}", e.getMessage());
            sendHttpResponse(ctx, response(HttpResponseStatus.SERVICE_UNAVAILABLE, null, "Discord authorization is unavailable"));
        } catch (Exception e) {
            logger.error("Portal Discord authorization error", e);
            sendHttpResponse(ctx, response(HttpResponseStatus.INTERNAL_SERVER_ERROR, null, "Discord authorization failed"));
        }
    }

    private DiscordAuthCoreProvider findDiscordProvider() {
        for (AuthProviderPair pair : server.config.auth.values()) {
            if (pair.core instanceof DiscordAuthCoreProvider provider) return provider;
        }
        return null;
    }

    private static String appendTicket(String callbackUrl, String ticket) {
        int fragment = callbackUrl.indexOf('#');
        String base = fragment < 0 ? callbackUrl : callbackUrl.substring(0, fragment);
        String suffix = fragment < 0 ? "" : callbackUrl.substring(fragment);
        return base + (base.contains("?") ? "&" : "?") + "ticket=" + ticket + suffix;
    }

    private static boolean hasMatchingStateCookie(FullHttpRequest request, String state) {
        String cookieHeader = request.headers().get(HttpHeaderNames.COOKIE);
        if (cookieHeader == null) return false;
        for (Cookie cookie : ServerCookieDecoder.STRICT.decode(cookieHeader)) {
            if (STATE_COOKIE.equals(cookie.name())) {
                return MessageDigest.isEqual(
                    state.getBytes(StandardCharsets.UTF_8), cookie.value().getBytes(StandardCharsets.UTF_8)
                );
            }
        }
        return false;
    }

    private static String stateCookie(String state, String redirectUrl) {
        return STATE_COOKIE + "=" + state + "; Path=/webapi/auth/discord/portal; Max-Age=600; HttpOnly; SameSite=Lax"
            + ("https".equalsIgnoreCase(URI.create(redirectUrl).getScheme()) ? "; Secure" : "");
    }

    private static void expireStateCookie(FullHttpResponse response, String redirectUrl) {
        response.headers().add(HttpHeaderNames.SET_COOKIE,
            STATE_COOKIE + "=; Path=/webapi/auth/discord/portal; Max-Age=0; HttpOnly; SameSite=Lax"
                + ("https".equalsIgnoreCase(URI.create(redirectUrl).getScheme()) ? "; Secure" : ""));
    }

    private static FullHttpResponse redirect(String location) {
        return response(HttpResponseStatus.FOUND, location, null);
    }

    private static FullHttpResponse response(HttpResponseStatus status, String location, String message) {
        FullHttpResponse response = new DefaultFullHttpResponse(HTTP_1_1, status,
            message == null ? io.netty.buffer.Unpooled.EMPTY_BUFFER :
                io.netty.buffer.Unpooled.copiedBuffer(message, java.nio.charset.StandardCharsets.UTF_8));
        if (location != null) response.headers().set(HttpHeaderNames.LOCATION, location);
        if (message != null) response.headers().set(HttpHeaderNames.CONTENT_TYPE, "text/plain; charset=UTF-8");
        response.headers().set(HttpHeaderNames.CACHE_CONTROL, "no-store");
        response.headers().set("Referrer-Policy", "no-referrer");
        return response;
    }
}
