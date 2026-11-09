package space.tcymc.astering;

import static org.junit.Assert.*;

import java.nio.charset.StandardCharsets;
import java.util.Base64;
import java.util.List;
import org.junit.Test;

public final class SessionSecurityTest {
    private static final String SID_A = "cc9e8357-d681-4d72-9063-992feae42de2";
    private static final String SID_B = "152d6483-649c-4a6a-b570-598329cc953d";

    private static String token(long uid, String sid, long issued) {
        String payload = "{\"type\":1,\"id\":" + uid + ",\"sid\":\"" + sid + "\",\"iat\":"
            + issued + ",\"exp\":" + (issued + 900) + "}";
        return "e30." + Base64.getUrlEncoder().withoutPadding().encodeToString(payload.getBytes(StandardCharsets.UTF_8)) + ".test";
    }

    @Test public void bridgeOriginRejectsLookalikesUserInfoOtherPortsAndSchemes() {
        assertTrue(SitePolicy.isTrusted("https://task.tcymc.space"));
        assertTrue(SitePolicy.isTrusted("https://task.tcymc.space:443/notes/1"));
        for (String origin : List.of("http://task.tcymc.space", "https://task.tcymc.space.attacker.test",
            "https://attacker.test@task.tcymc.space", "https://task.tcymc.space:444", "file:///notes",
            "javascript:alert(1)", "https://task.tcymc.space\\@attacker.test", "https://task.tcymc.space.")) {
            assertFalse(origin, SitePolicy.isTrusted(origin));
        }
    }

    @Test public void malformedSharedOrNonHumanTokensCannotOwnNativeRecorder() {
        assertNull(SessionIdentity.parse("not-a-token"));
        assertNull(SessionIdentity.parse(token(-1, SID_A, 100)));
        assertNull(SessionIdentity.parse(token(1, "not-a-session", 100)));
        assertNotNull(SessionIdentity.parse(token(1, SID_A, 100)));
        String share = "e30." + Base64.getUrlEncoder().withoutPadding().encodeToString(
            "{\"type\":2,\"id\":1,\"sid\":\"cc9e8357-d681-4d72-9063-992feae42de2\",\"iat\":100,\"exp\":1000}"
                .getBytes(StandardCharsets.UTF_8)) + ".test";
        assertNull(SessionIdentity.parse(share));
    }

    @Test public void sameSessionRefreshDoesNotCancelRecordingButOldTokenCannotDowngrade() {
        SessionFence sessions = new SessionFence();
        String first = token(1, SID_A, 100);
        String refreshed = token(1, SID_A, 200);
        assertTrue(sessions.set(first));
        SessionFence.Ticket recording = sessions.ticket();
        assertFalse(sessions.set(refreshed));
        assertTrue(sessions.current(recording));
        assertFalse(sessions.set(first));
        assertEquals(refreshed, sessions.ticket().token);
    }

    @Test public void logoutAndReloginSameUserPermanentlyFenceOldRefreshAndRecordingTickets() {
        SessionFence sessions = new SessionFence();
        sessions.set(token(1, SID_A, 100));
        SessionFence.Ticket pendingRefresh = sessions.ticket();
        sessions.clear();
        assertFalse(sessions.current(pendingRefresh));
        sessions.set(token(1, SID_A, 200));
        assertFalse(sessions.current(pendingRefresh));
        SessionFence.Ticket restored = sessions.ticket();
        sessions.set(token(1, SID_B, 300));
        assertFalse(sessions.current(restored));
    }

    @Test public void oldNotificationDoesNotStopNewRecordingAndOwnerChangeInvalidatesOldApproval() {
        SessionFence sessions = new SessionFence();
        sessions.set(token(1, SID_A, 100));
        RecordingLease first = new RecordingLease(sessions.ticket(), 7, "first-recording");
        RecordingLease second = new RecordingLease(sessions.ticket(), 7, "second-recording");
        assertFalse(second.notificationMatches(first.generation, first.noteID));
        assertTrue(second.notificationMatches(second.generation, 7));
        assertFalse(second.notificationMatches(second.generation, 8));
        sessions.set(token(1, SID_B, 200));
        assertFalse(first.matches(sessions.ticket(), 7));
        assertFalse(second.matches(sessions.ticket(), 7));
    }

    @Test public void refreshCookiesOnlyAcceptBothHttpOnlyHostOnlySecureEndpointPathsWithSameValue() {
        String a = "vikunja_refresh_token=fixture-A; Path=/api/v1/user/token/refresh; Secure; HttpOnly; SameSite=Lax";
        String b = a.replace("/v1/", "/v2/");
        assertEquals(2, NativeSession.refreshCookies(List.of(a, b)).size());
        assertEquals(0, NativeSession.refreshCookies(List.of(a, b.replace("fixture-A", "fixture-B"))).size());
        assertEquals(1, NativeSession.refreshCookies(List.of(a, b.replace("; Secure", ""))).size());
        assertEquals(1, NativeSession.refreshCookies(List.of(a, b + "; Domain=task.tcymc.space")).size());
        assertEquals(0, NativeSession.refreshCookies(List.of(a.replace("/api/v1/user/token/refresh", "/"))).size());
        assertEquals("fixture-A", SitePolicy.cookieValue("other=value; vikunja_refresh_token=fixture-A"));
    }
}
