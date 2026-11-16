package space.tcymc.astering;

import org.json.JSONObject;

/** A typed SPA destination, never a URL or javascript supplied through an exported Activity. */
final class NotificationTarget {
    final String kind;
    final String id;
    private NotificationTarget(String kind, String id) { this.kind = kind; this.id = id; }
    static NotificationTarget parse(String kind, String id) {
        if ("notifications".equals(kind) && "".equals(id)) return new NotificationTarget(kind, id);
        if ("task".equals(kind) || "project".equals(kind)) {
            try {
                if (id != null && id.matches("[1-9][0-9]{0,15}") && Long.toString(NotificationSnapshot.positive(Long.parseLong(id))).equals(id))
                    return new NotificationTarget(kind, id);
            } catch (IllegalArgumentException ignored) { return null; }
        }
        if ("automation".equals(kind)) {
            try {
                if (id != null && java.util.UUID.fromString(id).toString().equals(id)) return new NotificationTarget(kind, id);
            } catch (IllegalArgumentException ignored) { return null; }
        }
        return null;
    }
    JSONObject json() { return AsteringApplication.object("kind", kind, "id", id); }
}
