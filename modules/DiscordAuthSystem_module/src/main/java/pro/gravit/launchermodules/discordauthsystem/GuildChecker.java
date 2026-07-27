package pro.gravit.launchermodules.discordauthsystem;

import java.io.IOException;
import java.util.HashSet;
import java.util.List;
import java.util.Set;

public class GuildChecker {
    private final DiscordOAuthClient client;
    private final DiscordAuthSystemConfig config;

    public GuildChecker(DiscordOAuthClient client, DiscordAuthSystemConfig config) {
        this.client = client;
        this.config = config;
    }

    public GuildResult checkGuilds(String userId, String accessToken) throws IOException {
        if (config.requiredGuildIds == null || config.requiredGuildIds.isEmpty()) {
            return new GuildResult(true, null);
        }

        List<DiscordOAuthClient.GuildMember> members = client.fetchGuildMembers(accessToken);
        Set<String> memberIds = new HashSet<>();
        for (DiscordOAuthClient.GuildMember member : members) {
            if (member.id != null) {
                memberIds.add(member.id);
            }
        }

        for (String requiredId : config.requiredGuildIds) {
            if (memberIds.contains(requiredId)) {
                if (!config.useGlobalNickname) {
                    DiscordOAuthClient.GuildMember detailed = client.fetchGuildMember(requiredId, userId, accessToken);
                    if (detailed != null && detailed.nick != null && !detailed.nick.isEmpty()) {
                        return new GuildResult(true, detailed.nick);
                    }
                }
                return new GuildResult(true, null);
            }
        }

        return new GuildResult(false, null);
    }

    public record GuildResult(boolean allowed, String nickname) {}
}
