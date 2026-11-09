package space.tcymc.astering;

import android.os.Handler;
import android.os.Looper;
import android.webkit.CookieManager;
import java.io.IOException;
import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicReference;
import okhttp3.Call;
import okhttp3.Cookie;
import okhttp3.HttpUrl;
import okhttp3.OkHttpClient;
import okhttp3.Request;
import okhttp3.RequestBody;
import okhttp3.Response;
import org.json.JSONObject;

final class NativeSession {
    interface Callback {
        void complete(String token, String error);
    }

    private final AsteringApplication app;
    private final Handler main = new Handler(Looper.getMainLooper());
    private final java.util.concurrent.ThreadPoolExecutor refreshes = new java.util.concurrent.ThreadPoolExecutor(
        1, 1, 0, TimeUnit.SECONDS, new java.util.concurrent.ArrayBlockingQueue<>(32));
    private final SessionFence fence = new SessionFence();
    private final OkHttpClient http = new OkHttpClient.Builder()
        .followRedirects(false)
        .followSslRedirects(false)
        .callTimeout(20, TimeUnit.SECONDS)
        .build();
    private String boundCookie = "";
    private int cookieWrites;
    private final List<Runnable> cookieIdle = new ArrayList<>();
    private volatile Call refreshCall;
    private final java.util.concurrent.atomic.AtomicBoolean verifying = new java.util.concurrent.atomic.AtomicBoolean();

    NativeSession(AsteringApplication app) {
        this.app = app;
        fence.bindServer(app.site == null ? "" : app.site.origin);
    }

    SessionFence.Ticket ticket() {
        return fence.ticket();
    }

    boolean current(SessionFence.Ticket ticket) {
        return fence.current(ticket) && app.site != null && app.site.origin.equals(ticket.origin);
    }

    boolean verified(SessionFence.Ticket ticket) {
        return current(ticket) && fence.verified(ticket);
    }

    void accept(String token) {
        requireMain();
        if (app.site == null) throw new IllegalArgumentException("server_required");
        boolean changed = fence.set(token);
        if (changed) {
            Call call = refreshCall;
            if (call != null) call.cancel();
            boundCookie = cookie();
            app.stopRecordingForSessionChange();
            if (app.offline != null) app.offline.changed();
        }
        ensureVerified();
    }

    void bindServer(SitePolicy site) {
        requireMain();
        clear();
        fence.bindServer(site == null ? "" : site.origin);
    }

    /** Cookie operations already handed to WebView cannot be canceled; cleanup waits for their callbacks. */
    void afterCookieWrites(Runnable ready, Runnable failed) {
        requireMain();
        if (cookieWrites == 0) { ready.run(); return; }
        cookieIdle.add(ready);
        main.postDelayed(() -> { if (cookieIdle.remove(ready)) failed.run(); }, 10000);
    }

    private void cookieWriteFinished() {
        requireMain();
        cookieWrites--;
        if (cookieWrites != 0) return;
        List<Runnable> waiting = new ArrayList<>(cookieIdle);
        cookieIdle.clear();
        for (Runnable ready : waiting) ready.run();
    }

    void ensureVerified() {
        SessionFence.Ticket requested = ticket();
        if (requested == null || verified(requested) || !verifying.compareAndSet(false, true)) return;
        // Offline data ownership needs a server-validated identity, not merely decoded JWT claims.
        refresh(requested.token, true, (token, error) -> {
            verifying.set(false);
            if (!current(requested)) { ensureVerified(); return; }
            if (error == null && !verified(ticket())) { ensureVerified(); return; }
            if (error != null && app.offline != null) app.offline.authenticationFailed(error);
        });
    }

    void clear() {
        requireMain();
        fence.clear();
        boundCookie = "";
        Call call = refreshCall;
        if (call != null) call.cancel();
        app.stopRecordingForSessionChange();
        if (app.offline != null) app.offline.changed();
    }

    void refresh(String requestingToken, boolean force, Callback callback) {
        SessionFence.Ticket requested = ticket();
        SessionIdentity claimed = SessionIdentity.parse(requestingToken);
        if (requested == null || !requested.owner.sameOwner(claimed)) {
            main.post(() -> callback.complete(null, "authentication"));
            return;
        }
        try {
            refreshes.execute(() -> {
            SessionFence.Ticket current = ticket();
            if (!current(requested) || current == null) {
                finish(callback, requested, null, "session_changed");
                return;
            }
            if (!current.token.equals(requestingToken)
                || !force && current.owner.expires - System.currentTimeMillis() / 1000L > 9 * 60) {
                finish(callback, requested, current.token, null);
                return;
            }
            try {
                String before = onMain(() -> {
                    if (!current(current)) return "";
                    String actual = cookie();
                    return actual.equals(boundCookie) ? actual : "";
                });
                if (before.isEmpty()) throw new SessionException("session_changed");
                SitePolicy site = SitePolicy.parseServer(current.origin);
                if (site == null) throw new SessionException("session_changed");
                Request request = new Request.Builder()
                    .url(site.refreshURL())
                    .header("Cookie", SitePolicy.REFRESH_COOKIE + "=" + before)
                    .header("Origin", current.origin)
                    .header("Accept", "application/json")
                    .header("Cache-Control", "no-store")
                    .post(RequestBody.create(new byte[0], null))
                    .build();
                Call call = http.newCall(request);
                refreshCall = call;
                if (!current(requested)) { call.cancel(); if (refreshCall == call) refreshCall = null;
                    finish(callback, requested, null, "session_changed"); return; }
                try (Response response = call.execute()) {
                    if (response.code() == 401 || response.code() == 403) throw new SessionException("authentication");
                    if (response.code() == 429) throw new SessionException("rate_limited");
                    if (!response.isSuccessful() || response.body() == null) throw new SessionException("server");
                    if (response.body().contentLength() > 32768) throw new IOException("response_limit");
                    response.body().source().request(32769);
                    long size = response.body().source().getBuffer().size();
                    byte[] bytes = response.body().source().readByteArray(Math.min(32769, size));
                    if (bytes.length > 32768) throw new IOException("response_limit");
                    String token = new JSONObject(new String(bytes, java.nio.charset.StandardCharsets.UTF_8)).getString("token");
                    SessionIdentity next = SessionIdentity.parse(token);
                    if (!current.owner.sameOwner(next)) throw new SessionException("session_changed");
                    List<String> cookies = refreshCookies(current.origin, response.headers("Set-Cookie"));
                    if (cookies.size() != 2) throw new IOException("refresh_cookie_missing");
                    applyRefresh(current, before, token, cookies);
                    SessionFence.Ticket latest = ticket();
                    finish(callback, requested, latest == null ? null : latest.token, latest == null ? "session_changed" : null);
                } finally {
                    if (refreshCall == call) refreshCall = null;
                }
            } catch (SessionException error) {
                main.post(() -> {
                    if (current(requested)
                        && (error.code.equals("authentication") || error.code.equals("session_changed"))) clear();
                    callback.complete(null, error.code);
                });
            } catch (Exception ignored) {
                finish(callback, requested, null, "network");
            }
            });
        } catch (java.util.concurrent.RejectedExecutionException busy) {
            finish(callback, requested, null, "rate_limited");
        }
    }

    private void applyRefresh(SessionFence.Ticket ticket, String before, String token, List<String> headers)
        throws Exception {
        SitePolicy site = SitePolicy.parseServer(ticket.origin);
        if (site == null) throw new SessionException("session_changed");
        CountDownLatch done = new CountDownLatch(1);
        AtomicReference<String> error = new AtomicReference<>();
        main.post(() -> {
            if (!current(ticket) || !before.equals(cookie()) || !before.equals(boundCookie)) {
                error.set("session_changed");
                done.countDown();
                return;
            }
            // Enqueue both paths in this one main-thread turn, before logout or another login can interleave.
            java.util.concurrent.atomic.AtomicInteger remaining = new java.util.concurrent.atomic.AtomicInteger(headers.size());
            for (String header : headers) {
                cookieWrites++;
                java.util.concurrent.atomic.AtomicBoolean delivered = new java.util.concurrent.atomic.AtomicBoolean();
                android.webkit.ValueCallback<Boolean> saved = success -> {
                    if (!delivered.compareAndSet(false, true)) return;
                    try {
                        if (!success) error.set("refresh_cookie_failed");
                        if (remaining.decrementAndGet() != 0) return;
                        if (!current(ticket)) error.set("session_changed");
                        if (error.get() == null) {
                            boundCookie = cookie();
                            fence.set(token);
                            fence.markVerified(fence.ticket());
                            app.emitToken(fence.ticket(), fence.ticket().token);
                            if (app.offline != null) app.offline.authenticated();
                        }
                        done.countDown();
                    } finally { cookieWriteFinished(); }
                };
                try { CookieManager.getInstance().setCookie(site.refreshURL(), header, saved); }
                catch (RuntimeException rejected) { saved.onReceiveValue(false); }
            }
        });
        if (!done.await(8, TimeUnit.SECONDS)) throw new IOException("refresh_cookie_timeout");
        if (error.get() != null) throw new SessionException(error.get());
    }

    static List<String> refreshCookies(String origin, List<String> headers) {
        List<String> out = new ArrayList<>();
        boolean v1 = false;
        boolean v2 = false;
        String value = "";
        SitePolicy site = SitePolicy.parseServer(origin);
        if (site == null) return out;
        HttpUrl url = HttpUrl.get(site.refreshURL());
        for (String header : headers) {
            Cookie c = Cookie.parse(url, header);
            if (c == null || !c.name().equals(SitePolicy.REFRESH_COOKIE) || !c.hostOnly()
                || !c.secure() || !c.httpOnly() || !c.domain().equals(url.host()) || c.value().isEmpty()
                || c.expiresAt() <= System.currentTimeMillis()) continue;
            if (!value.isEmpty() && !value.equals(c.value())) return new ArrayList<>();
            if (c.path().equals("/api/v1/user/token/refresh") && !v1) {
                out.add(header);
                v1 = true;
                value = c.value();
            } else if (c.path().equals("/api/v2/user/token/refresh") && !v2) {
                out.add(header);
                v2 = true;
                value = c.value();
            }
        }
        return out;
    }

    private String cookie() {
        requireMain();
        SitePolicy site = app.site;
        return site == null ? "" : SitePolicy.cookieValue(CookieManager.getInstance().getCookie(site.refreshURL()));
    }

    private <T> T onMain(java.util.concurrent.Callable<T> work) throws Exception {
        CountDownLatch done = new CountDownLatch(1);
        AtomicReference<T> value = new AtomicReference<>();
        AtomicReference<Exception> failure = new AtomicReference<>();
        main.post(() -> {
            try {
                value.set(work.call());
            } catch (Exception e) {
                failure.set(e);
            } finally {
                done.countDown();
            }
        });
        if (!done.await(5, TimeUnit.SECONDS)) throw new IOException("main_thread_timeout");
        if (failure.get() != null) throw failure.get();
        return value.get();
    }

    private void finish(Callback callback, SessionFence.Ticket expected, String token, String error) {
        main.post(() -> {
            SessionFence.Ticket now = ticket();
            if (!current(expected) || token != null && (now == null || !now.owner.sameOwner(SessionIdentity.parse(token)))) {
                callback.complete(null, "session_changed");
            } else callback.complete(token, error);
        });
    }

    private static void requireMain() {
        if (Looper.myLooper() != Looper.getMainLooper()) throw new IllegalStateException("main_thread_required");
    }

    private static final class SessionException extends Exception {
        final String code;

        SessionException(String code) {
            this.code = code;
        }
    }
}
