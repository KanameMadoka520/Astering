package space.tcymc.astering;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.util.concurrent.TimeUnit;
import okhttp3.Call;
import okhttp3.MediaType;
import okhttp3.OkHttpClient;
import okhttp3.Request;
import okhttp3.RequestBody;
import okhttp3.Response;
import org.json.JSONObject;

/** No cookie jar, refresh, redirects or arbitrary URL: the background grant has only one GET destination. */
final class NotificationApi {
    static final String SNAPSHOT = "/api/v2/client/notifications/snapshot";
    static final String ISSUE = "/api/v2/user/client/notifications/token";
    private final OkHttpClient http;
    private volatile Call pending;
    NotificationApi() {
        this(new OkHttpClient.Builder().followRedirects(false).followSslRedirects(false)
            .connectTimeout(10, TimeUnit.SECONDS).readTimeout(15, TimeUnit.SECONDS).callTimeout(20, TimeUnit.SECONDS).build());
    }
    NotificationApi(OkHttpClient http) {
        this.http = http.newBuilder().followRedirects(false).followSslRedirects(false)
            .cookieJar(okhttp3.CookieJar.NO_COOKIES).cache(null).build();
    }

    JSONObject issue(String origin, String humanToken, String installation, String device) throws Exception {
        return execute(base(origin, ISSUE, humanToken).post(RequestBody.create(
            AsteringApplication.object("installation_id", installation, "device_name", device).toString(),
            MediaType.get("application/json; charset=utf-8"))).build(), 32768);
    }
    JSONObject snapshot(NotificationGrant grant) throws Exception {
        return execute(base(grant.origin, SNAPSHOT, grant.token).get().build(), NotificationSnapshot.MAX_BYTES);
    }
    void revoke(NotificationGrant grant, String humanToken) throws Exception {
        execute(base(grant.origin, "/api/v2/tokens/" + grant.tokenID, humanToken).delete().build(), 32768);
    }
    void cancel() { Call call = pending; if (call != null) call.cancel(); }

    static Request.Builder base(String origin, String path, String token) {
        SitePolicy site = SitePolicy.parseServer(origin);
        if (site == null || !site.origin.equals(origin) || token == null || token.isEmpty()
            || token.length() > 16384 || token.indexOf('\r') >= 0 || token.indexOf('\n') >= 0)
            throw new IllegalArgumentException("authentication");
        return new Request.Builder().url(origin + path).header("Authorization", "Bearer " + token)
            .header("Accept", "application/json").header("Cache-Control", "no-store");
    }
    private JSONObject execute(Request request, int limit) throws Exception {
        Call call = http.newCall(request);
        pending = call;
        try (Response response = call.execute()) {
            if (response.code() == 401 || response.code() == 403) throw new Failure("authentication");
            if (response.code() == 404) throw new Failure("unsupported");
            if (response.code() == 429) throw new Failure("rate_limited");
            if (!response.isSuccessful()) throw new Failure("server");
            if (response.code() == 204) return new JSONObject();
            if (response.body() == null || response.body().contentLength() > limit) throw new Failure("response_limit");
            response.body().source().request(limit + 1L);
            long available = response.body().source().getBuffer().size();
            if (available > limit) throw new Failure("response_limit");
            byte[] bytes = response.body().source().readByteArray(available);
            if (bytes.length == 0) return new JSONObject();
            return new JSONObject(new String(bytes, StandardCharsets.UTF_8));
        } catch (IOException network) { throw new Failure("network"); }
        finally { if (pending == call) pending = null; }
    }
    static final class Failure extends Exception {
        final String code;
        Failure(String code) { super(code); this.code = code; }
    }
}
