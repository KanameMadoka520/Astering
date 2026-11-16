package space.tcymc.astering;

import static org.junit.Assert.*;
import org.junit.Test;

public final class NotificationTargetTest {
    @Test public void acceptsOnlyCanonicalTypedDestinations() {
        assertNotNull(NotificationTarget.parse("notifications", ""));
        assertNotNull(NotificationTarget.parse("task", "1"));
        assertNotNull(NotificationTarget.parse("project", "9007199254740991"));
        assertNotNull(NotificationTarget.parse("automation", "cc9e8357-d681-4d72-9063-992feae42de2"));
        assertNull(NotificationTarget.parse("notifications", "/admin"));
        for (String invalid : new String[]{"0", "-1", "01", "1e3", " 1", "1/2", "9007199254740992", "9223372036854775807"}) {
            assertNull(invalid, NotificationTarget.parse("task", invalid));
            assertNull(invalid, NotificationTarget.parse("project", invalid));
        }
    }
    @Test public void externalUrlsAndArbitraryIntentsNeverBecomeNavigation() {
        for (String kind : new String[]{"url", "javascript", "intent", "admin", "notes", ""})
            assertNull(NotificationTarget.parse(kind, "https://other.example"));
        for (String id : new String[]{"not-a-uuid", "CC9E8357-D681-4D72-9063-992FEAE42DE2", "1-1-1-1-1", "../settings", ""})
            assertNull(NotificationTarget.parse("automation", id));
        assertNull(NotificationTarget.parse(null, null));
    }
}
