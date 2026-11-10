package space.tcymc.astering;

import android.os.Handler;
import android.os.Looper;
import java.io.File;
import java.util.List;
import java.util.concurrent.ScheduledThreadPoolExecutor;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.atomic.AtomicReference;
import okhttp3.Call;
import okhttp3.MediaType;
import okhttp3.OkHttpClient;
import okhttp3.Request;
import okhttp3.RequestBody;
import okhttp3.Response;
import org.json.JSONObject;

/** Finite text outbox; retries are idempotent and only use the currently selected account. */
final class OfflineTranscripts {
    interface Callback { void complete(JSONObject result, String error); }
    private final AsteringApplication app;
    private final TranscriptOutbox store;
    private final ScheduledThreadPoolExecutor worker = new ScheduledThreadPoolExecutor(1);
    private final java.util.concurrent.ThreadPoolExecutor storage = new java.util.concurrent.ThreadPoolExecutor(
        1, 1, 0, TimeUnit.SECONDS, new java.util.concurrent.ArrayBlockingQueue<>(64),
        runnable -> new Thread(runnable, "Astering-TranscriptStorage"));
    private java.util.concurrent.ScheduledFuture<?> retry;
    private final Handler main = new Handler(Looper.getMainLooper());
    private final OkHttpClient http = new OkHttpClient.Builder().followRedirects(false).followSslRedirects(false)
        .callTimeout(25, TimeUnit.SECONDS).build();
    private volatile Call call;
    private volatile String syncError = "";
    private boolean scheduled;
    private int attempts;
    private volatile long epoch;
    OfflineTranscripts(AsteringApplication app) {
        this.app = app; store = new TranscriptOutbox(app); worker.setRemoveOnCancelPolicy(true);
    }
    void changed() {
        epoch++; syncError = "";
        Call current = call; if (current != null) current.cancel();
        SessionFence.Ticket owner = app.session.ticket();
        if (owner != null) storeWork(() -> emitStatus(owner, null, false), (result, code) -> {});
        kick(true);
    }
    void modelChanged() {
        SessionFence.Ticket owner = app.session.ticket();
        if (owner != null) storeWork(() -> emitStatus(owner, null, false), (result, code) -> {});
    }
    void authenticationFailed(String error) {
        syncError = error.equals("authentication") ? "authentication" : error.equals("rate_limited") ? "rate_limited" : "network";
        SessionFence.Ticket owner = app.session.ticket();
        if (owner != null) storeWork(() -> emitStatus(owner, null, false), (result, code) -> {});
    }
    void authenticated() {
        SessionFence.Ticket owner = app.session.ticket();
        if (owner != null && app.session.verified(owner)) {
            storeWork(() -> emit(owner, null), (result, code) -> {});
            kick(true);
        }
    }
    void status(Callback callback) {
        SessionFence.Ticket owner = app.session.ticket();
        if (owner == null) { callback.complete(null, "authentication"); return; }
        storeWork(() -> {
            JSONObject result = status(owner);
            main.post(() -> callback.complete(app.session.current(owner) ? result : null,
                app.session.current(owner) ? null : "session_changed"));
        }, callback);
    }
    void list(long noteID, int offset, int limit, String after, Callback callback) {
        SessionFence.Ticket owner = app.session.ticket();
        if (owner == null || !app.session.verified(owner)) { callback.complete(null, "authentication"); return; }
        if (noteID < 0 || offset < 0 || offset > TranscriptOutbox.MAX_ITEMS || limit < 1 || limit > 50
            || !after.isEmpty() && !after.matches("[0-9]{19}:[a-f0-9-]{36}\\.bin")) {
            callback.complete(null, "invalid_request"); return;
        }
        storeWork(() -> {
            try {
                List<File> files = store.pending(owner.origin, owner.owner.userID);
                org.json.JSONArray entries = new org.json.JSONArray();
                int cursor = after.isEmpty() ? Math.min(offset, files.size()) : 0, scanned = 0, bytes = 0;
                String nextCursor = after;
                while (cursor < files.size() && entries.length() < limit) {
                    File file = files.get(cursor);
                    String key = String.format(java.util.Locale.ROOT, "%019d:%s", file.lastModified(), file.getName());
                    if (!after.isEmpty() && key.compareTo(after) <= 0) { cursor++; continue; }
                    if (scanned++ >= 100) break;
                    JSONObject entry = store.read(owner.origin, owner.owner.userID, file);
                    if (noteID != 0 && entry.getLong("note_id") != noteID) { nextCursor = key; cursor++; continue; }
                    int size = entry.toString().getBytes(java.nio.charset.StandardCharsets.UTF_8).length;
                    if (bytes + size > 180 * 1024) break;
                    entries.put(entry); bytes += size; nextCursor = key; cursor++;
                }
                JSONObject result = AsteringApplication.object("entries", entries, "next_offset", cursor, "next_cursor", nextCursor,
                    "has_more", cursor < files.size(), "status", status(owner));
                main.post(() -> callback.complete(app.session.current(owner) ? result : null,
                    app.session.current(owner) ? null : "session_changed"));
            } catch (Exception failure) { main.post(() -> callback.complete(null, "local_storage")); }
        }, callback);
    }
    private JSONObject status(SessionFence.Ticket owner) {
        boolean verified = app.session.verified(owner);
        long user = owner.owner.userID;
        JSONObject result = verified ? store.status(owner.origin, user) : AsteringApplication.object("pending_count", 0, "pending_bytes", 0,
            "max_pending_count", TranscriptOutbox.MAX_ITEMS, "max_pending_bytes", TranscriptOutbox.MAX_BYTES);
        try {
            JSONObject legacy = verified ? store.legacyStatus(owner.origin, user) : AsteringApplication.object("pending_count", 0, "pending_bytes", 0);
            result.put("legacy_pending_count", legacy.optInt("pending_count"));
            result.put("legacy_pending_bytes", legacy.optLong("pending_bytes"));
            result.put("server_origin", owner.origin);
            result.put("available", true); result.put("ready", verified); result.put("engine", "local");
            OfflineModelCatalog.Model selected = app.models.selected();
            result.put("model_id", selected == null ? "" : selected.id);
            result.put("model", selected == null ? app.getString(R.string.models_none) : selected.name);
            result.put("model_ready", selected != null);
            result.put("audio_persisted", false); result.put("sync_error", syncError);
            result.put("sample_rate", 16000); result.put("user_id", user);
            result.put("bytes", selected == null ? 0 : selected.bytes());
            result.put("source", selected == null ? "" : selected.source);
            result.put("license", selected == null ? "" : selected.license);
        } catch (org.json.JSONException impossible) { throw new IllegalStateException(impossible); }
        return result;
    }
    void clear(Callback callback) {
        SessionFence.Ticket owner = app.session.ticket();
        if (owner == null || !app.session.verified(owner)) { callback.complete(null, "authentication"); return; }
        RecordingService recorder = app.recorder;
        if (recorder != null) { callback.complete(null, "already_recording"); return; }
        epoch++; Call active = call; if (active != null) active.cancel();
        storeWork(() -> {
            if (!app.session.current(owner)) { main.post(() -> callback.complete(null, "session_changed")); return; }
            store.clear(owner.origin, owner.owner.userID); syncError = ""; kick(true);
            JSONObject result = status(owner);
            main.post(() -> callback.complete(app.session.current(owner) ? result : null,
                app.session.current(owner) ? null : "session_changed"));
        }, callback);
    }
    void migrateLegacy(SessionFence.Ticket owner, Callback callback) {
        if (!app.session.verified(owner) || !SitePolicy.LEGACY_OUTBOX_ORIGIN.equals(owner.origin)) {
            callback.complete(null, "authentication"); return;
        }
        if (app.recorder != null) { callback.complete(null, "already_recording"); return; }
        storeWork(() -> {
            try {
                store.migrateLegacy(owner.origin, owner.owner.userID, () -> app.session.current(owner));
                JSONObject result = status(owner);
                main.post(() -> {
                    if (!app.session.current(owner)) { callback.complete(null, "session_changed"); return; }
                    callback.complete(result, null); kick(true);
                });
            } catch (Exception failure) {
                String code = failure instanceof IllegalStateException && "session_changed".equals(failure.getMessage())
                    ? "session_changed" : failure instanceof IllegalStateException ? "local_storage_full" : "local_storage";
                main.post(() -> callback.complete(null, code));
            }
        }, callback);
    }
    void save(SessionFence.Ticket owner, JSONObject payload, Callback callback) {
        storeWork(() -> {
            try {
                // Captured text belongs to its original owner even if UI changes accounts while fsync completes.
                store.add(owner.origin, owner.owner.userID, payload);
                emit(owner, null);
                main.post(() -> { callback.complete(payload, null); kick(false); });
            } catch (Exception failure) {
                String code = failure instanceof IllegalStateException ? "local_storage_full" : "local_storage";
                main.post(() -> callback.complete(null, code));
            }
        }, callback);
    }
    private void storeWork(Runnable task, Callback callback) {
        try { storage.execute(task); }
        catch (java.util.concurrent.RejectedExecutionException full) {
            main.post(() -> callback.complete(null, "local_storage_full"));
        }
    }
    void kick(boolean explicit) {
        worker.execute(() -> {
            if (explicit) {
                attempts = 0; syncError = "";
                if (retry != null) retry.cancel(false);
                retry = null; scheduled = false;
            }
            if (scheduled) return;
            scheduled = true;
            retry = worker.schedule(() -> { scheduled = false; retry = null; drain(); }, 200, TimeUnit.MILLISECONDS);
        });
    }
    private void drain() {
        SessionFence.Ticket owner = app.session.ticket();
        if (owner == null || !app.session.verified(owner) || attempts >= 8) return;
        List<File> pending = store.pending(owner.origin, owner.owner.userID);
        if (pending.isEmpty()) { attempts = 0; syncError = ""; emit(owner, null); return; }
        long generation = epoch;
        try {
            CountDownLatch refreshed = new CountDownLatch(1);
            AtomicReference<String> token = new AtomicReference<>();
            AtomicReference<String> error = new AtomicReference<>();
            app.session.refresh(owner.token, false, (value, code) -> { token.set(value); error.set(code); refreshed.countDown(); });
            if (!refreshed.await(30, TimeUnit.SECONDS)) throw new java.io.IOException("network");
            if (error.get() != null) throw new java.io.IOException(error.get());
            if (generation != epoch || !app.session.current(owner)) return;
            File file = pending.get(0);
            JSONObject payload;
            try { payload = store.read(owner.origin, owner.owner.userID, file); }
            catch (Exception corrupt) { syncError = "local_storage"; attempts = 8; emit(owner, null); return; }
            long note = payload.getLong("note_id");
            if (note <= 0) throw new IllegalArgumentException("invalid_request");
            Request request = new Request.Builder().url(owner.origin + "/api/v2/notes/" + note + "/segments/import")
                .header("Authorization", "Bearer " + token.get()).header("Origin", owner.origin)
                .header("Cache-Control", "no-store")
                .post(RequestBody.create(payload.toString(), MediaType.get("application/json"))).build();
            Call current = http.newCall(request); call = current;
            if (generation != epoch || !app.session.current(owner)) { current.cancel(); if (call == current) call = null; return; }
            try (Response response = current.execute()) {
                if (generation != epoch || !app.session.current(owner)) return;
                if (!response.isSuccessful()) {
                    int code = response.code();
                    syncError = code == 401 || code == 403 ? "authentication" : code == 404 ? "note_unavailable"
                        : code == 409 ? "sync_conflict" : code == 429 ? "rate_limited" : "network";
                    if (code >= 400 && code < 500 && code != 408 && code != 429) {
                        attempts = 8; emit(owner, null); return;
                    }
                    throw new java.io.IOException(syncError);
                }
                if (response.body() == null || response.body().contentLength() > 262144) throw new java.io.IOException("protocol");
                response.body().source().request(262145);
                if (response.body().source().getBuffer().size() > 262144) throw new java.io.IOException("protocol");
                JSONObject receipt = new JSONObject(response.body().string());
                JSONObject segment = receipt.getJSONObject("segment");
                if (segment.getLong("note_id") != note || !segment.getString("client_id").equals(payload.getString("client_id")))
                    throw new java.io.IOException("protocol");
                store.remove(owner.origin, owner.owner.userID, file); syncError = ""; attempts = 0;
                emit(owner, receipt);
            } finally { if (call == current) call = null; }
            if (generation == epoch) kick(false);
        } catch (Exception failure) {
            if (generation != epoch || !app.session.current(owner)) return;
            if (syncError.isEmpty()) syncError = "network";
            attempts++;
            emit(owner, null);
            if (attempts < 8 && !scheduled) {
                scheduled = true;
                retry = worker.schedule(() -> { scheduled = false; retry = null; drain(); },
                    Math.min(120, 2L << Math.min(attempts, 6)), TimeUnit.SECONDS);
            }
        }
    }
    private void emit(SessionFence.Ticket owner, JSONObject receipt) { emitStatus(owner, receipt, true); }
    private void emitStatus(SessionFence.Ticket owner, JSONObject receipt, boolean requireVerified) {
        JSONObject status = status(owner);
        main.post(() -> {
            if (!app.session.current(owner) || requireVerified && !app.session.verified(owner)) return;
            JSONObject event = AsteringApplication.object("event", "offline", "user_id", owner.owner.userID,
                "server_origin", owner.origin, "status", status);
            try { if (receipt != null) event.put("receipt", receipt); }
            catch (org.json.JSONException impossible) { throw new IllegalStateException(impossible); }
            app.emit(event);
        });
    }
}
