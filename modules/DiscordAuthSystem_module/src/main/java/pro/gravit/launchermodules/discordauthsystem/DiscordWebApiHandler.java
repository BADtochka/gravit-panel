package pro.gravit.launchermodules.discordauthsystem;

import io.netty.buffer.Unpooled;
import io.netty.channel.ChannelHandlerContext;
import io.netty.handler.codec.http.*;
import org.apache.logging.log4j.LogManager;
import org.apache.logging.log4j.Logger;
import pro.gravit.launcher.base.request.auth.password.AuthCodePassword;
import pro.gravit.launchserver.LaunchServer;
import pro.gravit.launchserver.auth.AuthException;
import pro.gravit.launchserver.auth.AuthProviderPair;
import pro.gravit.launchserver.manangers.AuthManager;
import pro.gravit.launchserver.socket.Client;
import pro.gravit.launchserver.socket.NettyConnectContext;
import pro.gravit.launchserver.socket.handlers.NettyWebAPIHandler;

import java.io.IOException;
import java.util.Map;
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

        AtomicReference<Client> matchedClient = new AtomicReference<>();
        server.nettyServerSocketHandler.nettyServer.service.forEachActiveChannels((ch, ws) -> {
            Client client = ws.getClient();
            if (client == null) return;
            if (provider.consumePendingState(state, client)) {
                matchedClient.compareAndSet(null, client);
            }
        });

        Client client = matchedClient.get();
        if (client == null) {
            sendHttpResponse(ctx, authorizationPage(
                HttpResponseStatus.BAD_REQUEST,
                "Authorization link expired",
                "Return to the launcher and start Discord authorization again.",
                false
            ));
            return;
        }

        AuthManager.AuthReport report;
        try {
            report = provider.authorize("", null, new AuthCodePassword(code), true);
        } catch (AuthException e) {
            logger.warn("Discord authorization failed: {}", e.getMessage());
            sendHttpResponse(ctx, authorizationPage(
                HttpResponseStatus.FORBIDDEN,
                "Authorization failed",
                e.getMessage(),
                false
            ));
            return;
        } catch (Exception e) {
            logger.error("Discord authorization error", e);
            sendHttpResponse(ctx, authorizationPage(
                HttpResponseStatus.INTERNAL_SERVER_ERROR,
                "Authorization failed",
                "An internal error occurred. Return to the launcher and try again.",
                false
            ));
            return;
        }

        // LauncherRuntime finishes external web auth with a normal AuthRequest
        // after the user clicks its confirmation button. Keep the completed
        // report pending for that request instead of marking the WebSocket
        // client authenticated here; doing so would make the normal request
        // fail with "You are already logged in".
        provider.completeBrowserAuthorization(client, report);
        sendHttpResponse(ctx, authorizationPage(
            HttpResponseStatus.OK,
            "Authorization complete",
            "Return to the launcher and click Confirm login.",
            true
        ));
    }

    private AuthProviderPair findDiscordProvider() {
        for (var entry : server.config.auth.entrySet()) {
            if (entry.getValue().core instanceof DiscordAuthCoreProvider) {
                return entry.getValue();
            }
        }
        return null;
    }

    private FullHttpResponse authorizationPage(
        HttpResponseStatus status,
        String title,
        String message,
        boolean success
    ) {
        String accent = success ? "#34d399" : "#fb7185";
        String icon = success ? "&#10003;" : "!";
        String html = "<!DOCTYPE html><html lang='en'><head><meta charset='utf-8'>"
            + "<meta name='viewport' content='width=device-width,initial-scale=1'>"
            + "<title>" + escapeHtml(title) + "</title><style>"
            + "*{box-sizing:border-box}body{margin:0;min-height:100vh;display:grid;place-items:center;"
            + "padding:24px;background:#09090b;color:#fafafa;font-family:Inter,system-ui,sans-serif}"
            + "main{width:min(460px,100%);padding:36px;border:1px solid #27272a;border-radius:20px;"
            + "background:#111113;box-shadow:0 24px 80px #0008;text-align:center}"
            + ".icon{width:52px;height:52px;margin:0 auto 20px;display:grid;place-items:center;"
            + "border:1px solid " + accent + ";border-radius:50%;color:" + accent + ";font-size:28px}"
            + "h1{margin:0 0 12px;font-size:24px}p{margin:0;color:#a1a1aa;line-height:1.6}"
            + "</style></head><body><main><div class='icon'>" + icon + "</div><h1>"
            + escapeHtml(title) + "</h1><p>" + escapeHtml(message) + "</p></main></body></html>";
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
