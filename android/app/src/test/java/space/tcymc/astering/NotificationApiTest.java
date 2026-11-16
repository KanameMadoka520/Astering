package space.tcymc.astering;

import static org.junit.Assert.*;
import java.util.ArrayList;
import java.util.List;
import java.util.UUID;
import okhttp3.MediaType;
import okhttp3.OkHttpClient;
import okhttp3.Protocol;
import okhttp3.Request;
import okhttp3.Response;
import okhttp3.ResponseBody;
import org.json.JSONObject;
import org.junit.Test;

/** Real OkHttp request/response pipeline, with an interceptor preventing every external connection. */
public final class NotificationApiTest {
    private static final String ORIGIN = "https://personal.example";
    private final List<Request> requests = new ArrayList<>();
    private int responseCode = 200;
    private String responseBody = "{}";
    private NotificationApi api() {
        return new NotificationApi(new OkHttpClient.Builder().addInterceptor(chain -> {
            requests.add(chain.request());
            return new Response.Builder().request(chain.request()).protocol(Protocol.HTTP_1_1).code(responseCode)
                .message("Fixture").header("Location", "https://other.example/steal")
                .body(ResponseBody.create(responseBody, MediaType.get("application/json"))).build();
        }).build());
    }
    private NotificationGrant grant() {
        return new NotificationGrant(ORIGIN, 3, 42, "notification-device-only-secret", 9_000_000_000_000L, UUID.randomUUID().toString());
    }

    @Test public void backgroundGrantUsesOnlyFixedReadEndpointWithoutCookiesOrQuery() throws Exception {
        api().snapshot(grant());
        assertEquals(1, requests.size());
        Request sent = requests.get(0);
        assertEquals(ORIGIN + NotificationApi.SNAPSHOT, sent.url().toString());
        assertEquals("GET", sent.method());
        assertEquals("Bearer notification-device-only-secret", sent.header("Authorization"));
        assertNull(sent.header("Cookie"));
        assertEquals("no-store", sent.header("Cache-Control"));
    }

    @Test public void onlyExplicitHumanIssueAndRevokeUseHumanCredential() throws Exception {
        NotificationApi api = api();
        String installation = UUID.randomUUID().toString();
        api.issue(ORIGIN, "human-session-in-memory", installation, "My phone");
        api.revoke(grant(), "human-session-in-memory");
        Request issue = requests.get(0);
        assertEquals(ORIGIN + NotificationApi.ISSUE, issue.url().toString());
        assertEquals("POST", issue.method());
        okio.Buffer body = new okio.Buffer();
        issue.body().writeTo(body);
        JSONObject value = new JSONObject(body.readUtf8());
        assertEquals(2, value.length());
        assertEquals(installation, value.getString("installation_id"));
        assertEquals("My phone", value.getString("device_name"));
        assertEquals("Bearer human-session-in-memory", issue.header("Authorization"));
        assertEquals(ORIGIN + "/api/v2/tokens/42", requests.get(1).url().toString());
        assertEquals("DELETE", requests.get(1).method());
        assertNull(requests.get(1).header("Cookie"));
    }

    @Test public void redirectsAndRejectedCredentialsNeverBecomeSuccessfulSnapshots() throws Exception {
        for (int code : new int[]{301, 302, 307, 401, 403, 429, 500}) {
            responseCode = code;
            try { api().snapshot(grant()); fail("HTTP " + code + " must fail"); }
            catch (NotificationApi.Failure failure) {
                assertEquals(code == 401 || code == 403 ? "authentication" : code == 429 ? "rate_limited" : "server", failure.code);
            }
        }
        assertEquals(7, requests.size());
        for (Request request : requests) assertEquals("personal.example", request.url().host());
    }

    @Test public void responseLimitsAndOriginValidationFailBeforePrivateDataIsAccepted() throws Exception {
        responseBody = "x".repeat(NotificationSnapshot.MAX_BYTES + 1);
        try { api().snapshot(grant()); fail("oversized"); }
        catch (NotificationApi.Failure failure) { assertEquals("response_limit", failure.code); }
        for (String invalid : new String[]{"http://personal.example", "https://user@personal.example", ORIGIN + "/wrong", ORIGIN + "?x=1"}) {
            try { api().issue(invalid, "human", UUID.randomUUID().toString(), "phone"); fail(invalid); }
            catch (IllegalArgumentException expected) { /* No request may escape the selected exact origin. */ }
        }
        assertEquals(1, requests.size());
    }

    @Test public void tokenHeaderInjectionNeverDispatches() throws Exception {
        try { api().issue(ORIGIN, "token\r\nCookie: private", UUID.randomUUID().toString(), "phone"); fail("injection"); }
        catch (IllegalArgumentException expected) { assertTrue(requests.isEmpty()); }
    }
}
