package space.tcymc.astering;

import java.nio.charset.StandardCharsets;
import java.util.Base64;
import java.util.UUID;
import org.json.JSONObject;

final class SessionIdentity {
    final long userID;
    final String sid;
    final long expires;
    final long issued;

    private SessionIdentity(long userID, String sid, long expires, long issued) {
        this.userID = userID;
        this.sid = sid;
        this.expires = expires;
        this.issued = issued;
    }

    // This is an ownership fence, never authentication; the server verifies the signed JWT.
    static SessionIdentity parse(String token) {
        try {
            if (token == null || token.length() > 16384) return null;
            String[] parts = token.split("\\.", -1);
            if (parts.length != 3 || parts[2].isEmpty()) return null;
            JSONObject body = new JSONObject(new String(Base64.getUrlDecoder().decode(parts[1]), StandardCharsets.UTF_8));
            long id = body.getLong("id");
            String sid = body.getString("sid");
            long exp = body.getLong("exp");
            long issued = body.getLong("iat");
            if (body.getInt("type") != 1 || id <= 0 || exp <= 0
                || issued <= 0 || exp <= issued
                || !UUID.fromString(sid).toString().equals(sid)) return null;
            return new SessionIdentity(id, sid, exp, issued);
        } catch (Exception ignored) {
            return null;
        }
    }

    boolean sameOwner(SessionIdentity other) {
        return other != null && userID == other.userID && sid.equals(other.sid);
    }
}
