package space.tcymc.astering;

import java.net.IDN;
import java.net.URI;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.util.Locale;

/** One explicitly selected HTTPS origin. No instance exists before the user chooses a server. */
final class SitePolicy {
    static final String REFRESH_COOKIE = "vikunja_refresh_token";
    // Compatibility destination for user-confirmed v65 outbox recovery, never a default or network target.
    static final String LEGACY_OUTBOX_ORIGIN = "https://task.tcymc.space";
    final String origin;
    final String host;
    final int port;
    final String scope;

    private SitePolicy(String origin, String host, int port) {
        this.origin = origin;
        this.host = host;
        this.port = port;
        this.scope = scopeID(origin);
    }

    static SitePolicy parseServer(String raw) {
        try {
            if (raw == null || raw.trim().isEmpty() || raw.length() > 2048 || raw.indexOf('\\') >= 0)
                return null;
            String value = raw.trim();
            if (!value.contains("://")) value = "https://" + value;
            URI uri = URI.create(value);
            if (!"https".equalsIgnoreCase(uri.getScheme()) || uri.getRawUserInfo() != null
                || uri.getRawQuery() != null || uri.getRawFragment() != null
                || !(uri.getRawPath().isEmpty() || uri.getRawPath().equals("/"))
                || uri.getRawAuthority() == null) return null;
            String host = uri.getHost();
            if (host == null) return null;
            host = host.toLowerCase(Locale.ROOT);
            if (!host.startsWith("[")) host = IDN.toASCII(host, IDN.USE_STD3_ASCII_RULES);
            int port = uri.getPort();
            if (port == 0 || port < -1 || port > 65535) return null;
            if (port == 443) port = -1;
            String origin = "https://" + host + (port == -1 ? "" : ":" + port);
            return new SitePolicy(origin, host, port);
        } catch (IllegalArgumentException | NullPointerException ignored) {
            return null;
        }
    }

    boolean isTrusted(String raw) {
        try {
            URI uri = URI.create(raw);
            int candidatePort = uri.getPort() == 443 ? -1 : uri.getPort();
            return "https".equalsIgnoreCase(uri.getScheme()) && host.equalsIgnoreCase(uri.getHost())
                && candidatePort == port && uri.getRawUserInfo() == null && raw.indexOf('\\') < 0;
        } catch (IllegalArgumentException | NullPointerException ignored) {
            return false;
        }
    }

    String refreshURL() { return origin + "/api/v2/user/token/refresh"; }
    String liveURL() { return "wss://" + origin.substring("https://".length()) + "/api/v2/notes/live"; }

    static String scopeID(String origin) {
        try {
            byte[] bytes = MessageDigest.getInstance("SHA-256").digest(origin.getBytes(StandardCharsets.UTF_8));
            StringBuilder out = new StringBuilder();
            for (byte value : bytes) out.append(String.format(Locale.ROOT, "%02x", value & 255));
            return out.toString();
        } catch (java.security.NoSuchAlgorithmException impossible) {
            throw new IllegalStateException(impossible);
        }
    }

    static boolean isExternalWeb(String raw) {
        try {
            URI uri = URI.create(raw);
            return ("https".equals(uri.getScheme()) || "http".equals(uri.getScheme()))
                && uri.getHost() != null && uri.getRawUserInfo() == null && raw.indexOf('\\') < 0;
        } catch (IllegalArgumentException | NullPointerException ignored) {
            return false;
        }
    }

    static String cookieValue(String raw) {
        if (raw == null) return "";
        for (String part : raw.split(";")) {
            String value = part.trim();
            if (value.startsWith(REFRESH_COOKIE + "=")) return value.substring(REFRESH_COOKIE.length() + 1);
        }
        return "";
    }
}
