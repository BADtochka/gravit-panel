package pro.gravit.launchermodules.discordauthsystem;

import org.apache.logging.log4j.LogManager;
import org.apache.logging.log4j.Logger;
import pro.gravit.launcher.base.modules.LauncherInitContext;
import pro.gravit.launcher.base.modules.LauncherModule;
import pro.gravit.launcher.base.modules.LauncherModuleInfo;
import pro.gravit.launcher.base.modules.events.PreConfigPhase;
import pro.gravit.launchserver.LaunchServer;
import pro.gravit.launchserver.auth.core.AuthCoreProvider;
import pro.gravit.launchserver.modules.events.LaunchServerFullInitEvent;
import pro.gravit.launchserver.socket.handlers.NettyWebAPIHandler;
import pro.gravit.utils.Version;
import pro.gravit.utils.helper.LogHelper;

import java.io.IOException;

public class DiscordAuthSystemModule extends LauncherModule {
    public static final Version VERSION = new Version(1, 0, 9, 0, Version.Type.LTS);
    private static boolean registered = false;

    private final Logger logger = LogManager.getLogger();
    private DiscordAuthSystemConfig config;

    public DiscordAuthSystemModule() {
        super(new LauncherModuleInfo("DiscordAuthSystem", VERSION, new String[]{"LaunchServerCore"}));
    }

    @Override
    public void init(LauncherInitContext context) {
        registerEvent(this::onPreConfig, PreConfigPhase.class);
        registerEvent(this::onLaunchServerInit, LaunchServerFullInitEvent.class);
    }

    private void onPreConfig(PreConfigPhase phase) {
        if (registered) {
            return;
        }
        AuthCoreProvider.providers.register("discordauthsystem", DiscordAuthCoreProvider.class);
        registered = true;
        logger.info("DiscordAuthSystem auth core provider registered");
    }

    private void onLaunchServerInit(LaunchServerFullInitEvent event) {
        LaunchServer server = event.server;
        try {
            modulesConfigManager.getConfigurable(DiscordAuthSystemConfig.class, moduleInfo.name).loadConfig();
            this.config = modulesConfigManager.getConfigurable(DiscordAuthSystemConfig.class, moduleInfo.name).getConfig();
        } catch (IOException e) {
            LogHelper.error("Unable to load DiscordAuthSystem config", e);
            return;
        }

        DiscordAuthSystemContext.initialize(server, config);

        NettyWebAPIHandler.addNewSeverlet("auth/discord/portal", new DiscordPortalWebApiHandler(server));
        NettyWebAPIHandler.addNewSeverlet("auth/discord", new DiscordWebApiHandler(server));
        logger.info("DiscordAuthSystem web endpoint registered at /webapi/auth/discord");
        logger.info("DiscordAuthSystem portal endpoint registered at /webapi/auth/discord/portal");
    }

    public DiscordAuthSystemConfig getConfig() {
        return config;
    }
}
