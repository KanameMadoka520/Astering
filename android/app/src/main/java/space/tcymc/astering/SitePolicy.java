package space.tcymc.astering;

import java.net.URI;

final class SitePolicy {
    static final String ORIGIN = "https://task.tcymc.space";
    static final String REFRESH_URL = ORIGIN + "/api/v2/user/token/refresh";
    static final String LIVE_URL = "wss://task.tcymc.space/api/v2/notes/live";
    static final String REFRESH_COOKIE = "vikunja_refresh_token";

    private SitePolicy() {}

    static boolean isTrusted(String raw) {
        try {
            URI uri = URI.create(raw);
            return "https".equals(uri.getScheme())
                && "task.tcymc.space".equals(uri.getHost())
                && (uri.getPort() == -1 || uri.getPort() == 443)
                && uri.getRawUserInfo() == null;
        } catch (IllegalArgumentException | NullPointerException ignored) {
            return false;
        }
    }

    static boolean isExternalWeb(String raw) {
        try {
            URI uri = URI.create(raw);
            return ("https".equals(uri.getScheme()) || "http".equals(uri.getScheme()))
                && uri.getHost() != null
                && uri.getRawUserInfo() == null;
        } catch (IllegalArgumentException | NullPointerException ignored) {
            return false;
        }
    }

    static String cookieValue(String raw) {
        if (raw == null) return "";
        for (String part : raw.split(";")) {
            String value = part.trim();
            if (value.startsWith(REFRESH_COOKIE + "=")) {
                return value.substring(REFRESH_COOKIE.length() + 1);
            }
        }
        return "";
    }
}
