package pro.gravit.launchermodules.discordauthsystem;

import java.text.Normalizer;
import java.util.HashMap;
import java.util.Map;
import java.util.regex.Pattern;

public class NicknameFormatter {
    private static final Pattern WHITESPACE = Pattern.compile("[\\s\\p{Punct}&&[^_]]");
    private static final Pattern NON_ALPHANUMERIC_UNDERSCORE = Pattern.compile("[^a-zA-Z0-9_]");

    private static final Map<String, String> TRANSLIT = new HashMap<>();

    static {
        String[][] pairs = {
            {"а", "a"}, {"б", "b"}, {"в", "v"}, {"г", "g"}, {"д", "d"}, {"е", "e"},
            {"ё", "yo"}, {"ж", "zh"}, {"з", "z"}, {"и", "i"}, {"й", "y"}, {"к", "k"},
            {"л", "l"}, {"м", "m"}, {"н", "n"}, {"о", "o"}, {"п", "p"}, {"р", "r"},
            {"с", "s"}, {"т", "t"}, {"у", "u"}, {"ф", "f"}, {"х", "kh"}, {"ц", "ts"},
            {"ч", "ch"}, {"ш", "sh"}, {"щ", "sch"}, {"ъ", ""}, {"ы", "y"}, {"ь", ""},
            {"э", "e"}, {"ю", "yu"}, {"я", "ya"},
            {"А", "A"}, {"Б", "B"}, {"В", "V"}, {"Г", "G"}, {"Д", "D"}, {"Е", "E"},
            {"Ё", "Yo"}, {"Ж", "Zh"}, {"З", "Z"}, {"И", "I"}, {"Й", "Y"}, {"К", "K"},
            {"Л", "L"}, {"М", "M"}, {"Н", "N"}, {"О", "O"}, {"П", "P"}, {"Р", "R"},
            {"С", "S"}, {"Т", "T"}, {"У", "U"}, {"Ф", "F"}, {"Х", "Kh"}, {"Ц", "Ts"},
            {"Ч", "Ch"}, {"Ш", "Sh"}, {"Щ", "Sch"}, {"Э", "E"}, {"Ю", "Yu"}, {"Я", "Ya"},
        };
        for (String[] pair : pairs) {
            TRANSLIT.put(pair[0], pair[1]);
        }
    }

    public static String format(String input, DiscordAuthSystemConfig config) {
        if (input == null || input.isBlank()) {
            return null;
        }

        String normalized = Normalizer.normalize(input, Normalizer.Form.NFD)
            .replaceAll("\\p{InCombiningDiacriticalMarks}+", "");

        StringBuilder transliterated = new StringBuilder();
        for (int i = 0; i < normalized.length(); i++) {
            String ch = normalized.substring(i, i + 1);
            transliterated.append(TRANSLIT.getOrDefault(ch, ch));
        }

        String formatted = WHITESPACE.matcher(transliterated.toString()).replaceAll("_");
        formatted = NON_ALPHANUMERIC_UNDERSCORE.matcher(formatted).replaceAll("");
        formatted = formatted.replaceAll("_+", "_").replaceAll("^_|_$", "");

        formatted = config.usernameFormat
            .replace("{discord}", formatted)
            .replace("{username}", formatted);

        if (formatted.isEmpty() || !Pattern.matches(config.usernameRegex, formatted)) {
            return null;
        }

        return formatted;
    }
}
