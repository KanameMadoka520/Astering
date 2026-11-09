package space.tcymc.astering;

import static org.junit.Assert.*;
import java.util.List;
import org.junit.Test;

public final class SitePolicyTest {
    @Test public void emptyFirstLaunchHasNoDefaultOrFallbackServer() {
        assertNull(SitePolicy.parseServer(null));
        assertNull(SitePolicy.parseServer(""));
        assertNull(SitePolicy.parseServer("   "));
    }
    @Test public void explicitRootAddressNormalizesHttpsHostAndDefaultPort() {
        assertEquals("https://one.example", SitePolicy.parseServer(" HTTPS://ONE.EXAMPLE:443/ ").origin);
        assertEquals("https://one.example", SitePolicy.parseServer("one.example").origin);
        SitePolicy selected = SitePolicy.parseServer("one.example:8443/");
        assertEquals("https://one.example:8443", selected.origin);
        assertEquals("https://one.example:8443/api/v2/user/token/refresh", selected.refreshURL());
        assertEquals("wss://one.example:8443/api/v2/notes/live", selected.liveURL());
        assertNotEquals(selected.scope, SitePolicy.parseServer("one.example").scope);
        assertEquals(64, selected.scope.length());
    }
    @Test public void serverChoiceRejectsCredentialsOtherSchemesAndNonRootAddresses() {
        for (String invalid : List.of("http://one.example", "https://user:secret@one.example", "https://one.example/login",
            "https://one.example/api/v2", "https://one.example?key=secret", "https://one.example#fragment",
            "https://one.example/../", "https://one.example/%2F", "https://one.example\\@two.example", "javascript:alert(1)",
            "https://one.example:0", "https://one.example:65536", "file:///notes")) {
            assertNull(invalid, SitePolicy.parseServer(invalid));
        }
    }
    @Test public void selectedOriginMustMatchBothHostAndPortOnAllNavigations() {
        SitePolicy selected = SitePolicy.parseServer("https://one.example:8443");
        assertTrue(selected.isTrusted("https://ONE.example:8443/notes/1?q=2#text"));
        for (String other : List.of("https://one.example", "https://one.example:443", "http://one.example:8443",
            "https://one.example.attacker.test:8443", "https://attacker.test@one.example:8443", "https://one.example.:8443",
            "https://one.example:8443\\@two.example", "https://two.example:8443")) {
            assertFalse(other, selected.isTrusted(other));
        }
    }
}
