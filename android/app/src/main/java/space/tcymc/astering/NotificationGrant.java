package space.tcymc.astering;

import java.util.UUID;
import org.json.JSONObject;

/** Device-only permission: it never stores the full human login token or source SID. */
final class NotificationGrant {
    final String origin;
    final long userID;
    final long tokenID;
    final String token;
    final long expiresAt;
    final String generation;

    NotificationGrant(String origin, long userID, long tokenID, String token, long expiresAt, String generation) {
        SitePolicy site = SitePolicy.parseServer(origin);
        if (site == null || !site.origin.equals(origin) || token == null || token.length() < 16 || token.length() > 512
            || !token.matches("[A-Za-z0-9._~-]+") || expiresAt <= 0 || !UUID.fromString(generation).toString().equals(generation))
            throw new IllegalArgumentException("protocol");
        this.origin = origin;
        this.userID = NotificationSnapshot.positive(userID);
        this.tokenID = NotificationSnapshot.positive(tokenID);
        this.token = token;
        this.expiresAt = expiresAt;
        this.generation = generation;
    }

    static NotificationGrant issued(String origin, long userID, JSONObject value) throws Exception {
        long serverTime = NotificationSnapshot.instant(value.getString("server_time"));
        long expires = NotificationSnapshot.instant(value.getString("expires_at"));
        if (value.getLong("user_id") != userID || !value.getString("scope").equals("client:notifications_snapshot")
            || expires <= serverTime || expires - serverTime > 30 * 24 * 3600_000L + 60_000)
            throw new IllegalArgumentException("protocol");
        return new NotificationGrant(origin, userID, value.getLong("token_id"), value.getString("token"), expires,
            UUID.randomUUID().toString());
    }

    static NotificationGrant restore(JSONObject value) throws Exception {
        return new NotificationGrant(value.getString("origin"), value.getLong("user_id"), value.getLong("token_id"),
            value.getString("token"), value.getLong("expires_at"), value.getString("generation"));
    }

    JSONObject json() {
        return AsteringApplication.object("origin", origin, "user_id", userID, "token_id", tokenID, "token", token,
            "expires_at", expiresAt, "generation", generation);
    }
}
