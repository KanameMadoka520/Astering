package space.tcymc.astering;

import android.Manifest;
import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.content.pm.ServiceInfo;
import android.media.AudioFormat;
import android.media.AudioRecord;
import android.media.MediaRecorder;
import android.os.Build;
import android.os.IBinder;
import android.os.PowerManager;
import android.os.SystemClock;
import java.nio.ByteBuffer;
import java.nio.ByteOrder;
import java.util.concurrent.LinkedBlockingDeque;
import java.util.concurrent.ScheduledFuture;
import java.util.concurrent.ScheduledThreadPoolExecutor;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicBoolean;
import okhttp3.OkHttpClient;
import okhttp3.Request;
import okhttp3.Response;
import okhttp3.WebSocket;
import okhttp3.WebSocketListener;
import okio.ByteString;
import org.json.JSONObject;

public final class RecordingService extends Service {
    static final String START = "space.tcymc.astering.START_RECORDING";
    static final String STOP = "space.tcymc.astering.STOP_RECORDING";
    private static final String CHANNEL = "live-note-recording";
    private static final int NOTIFICATION = 64;
    private final ScheduledThreadPoolExecutor engine = new ScheduledThreadPoolExecutor(1);
    private final LinkedBlockingDeque<byte[]> audio = new LinkedBlockingDeque<>(40);
    private final AtomicBoolean reading = new AtomicBoolean();
    private final OkHttpClient http = new OkHttpClient.Builder()
        .followRedirects(false)
        .followSslRedirects(false)
        .connectTimeout(15, TimeUnit.SECONDS)
        .pingInterval(20, TimeUnit.SECONDS)
        .build();
    private AsteringApplication app;
    private SessionFence.Ticket owner;
    private RecordingLease lease;
    private String generation = "";
    private long noteID;
    private int rate;
    private String connection;
    private String language;
    private boolean background;
    private boolean keepAwake;
    private volatile boolean stoppingRequested;
    private volatile String state = "idle";
    private volatile WebSocket socket;
    private volatile AudioRecord microphone;
    private Thread audioThread;
    private long wire;
    private boolean ready;
    private boolean stopSent;
    private boolean rotating;
    private long wireSent;
    private long totalSent;
    private long offset;
    private final java.util.concurrent.atomic.AtomicLong capturedSamples = new java.util.concurrent.atomic.AtomicLong();
    private int rotateAt = 420;
    private long startedAt;
    private long lastPublished;
    private long lastSampleAt;
    private long lastSampleBytes;
    private long lastNotification;
    private double bytesPerSecond;
    private int savedSegments;
    private String partial = "";
    private String model = "";
    private String endpoint = "";
    private String error = "";
    private JSONObject lastSegment;
    private JSONObject lastStats;
    private ScheduledFuture<?> deadline;
    private LocalRecognizer local;
    private String asrEngine = "online";
    private String timezone;
    private long startOffset;
    private String recordingStartedAt;
    private boolean appendToArticle;
    private boolean localFinishing;
    private int pendingSaves;
    private String localText = "";
    private String localClientID = "";
    private long inferenceMs;
    private int retryAttempt;
    private boolean incompleteAudio;
    private long retryAt;
    private long wakeRenewAt;
    private String interruptedPartial = "";
    private PowerManager.WakeLock wakeLock;

    @Override public void onCreate() {
        super.onCreate();
        app = (AsteringApplication) getApplication();
        app.recorder = this;
        engine.setRemoveOnCancelPolicy(true);
        NotificationManager notifications = getSystemService(NotificationManager.class);
        notifications.createNotificationChannel(new NotificationChannel(CHANNEL, getString(R.string.recording_channel),
            NotificationManager.IMPORTANCE_LOW));
    }

    @Override public int onStartCommand(Intent intent, int flags, int startID) {
        if (intent == null) {
            stopSelf();
            return START_NOT_STICKY;
        }
        if (STOP.equals(intent.getAction())) {
            if (owner == null || state.equals("idle")) {
                stopSelf(startID);
                return START_NOT_STICKY;
            }
            if (lease != null && lease.notificationMatches(intent.getStringExtra("generation"), intent.getLongExtra("note_id", 0))) {
                stopFromPage();
            }
            return START_NOT_STICKY;
        }
        if (!START.equals(intent.getAction())) {
            if (state.equals("idle")) stopSelf(startID);
            return START_NOT_STICKY;
        }
        if (!state.equals("idle")) return START_NOT_STICKY;
        owner = app.session.ticket();
        RecordingLease approved = app.approvedRecording;
        if (!app.canStartRecording() || approved == null || !approved.matches(owner, intent.getLongExtra("note_id", 0))
            || !approved.notificationMatches(intent.getStringExtra("generation"), intent.getLongExtra("note_id", 0))
            || owner == null || owner.epoch != intent.getLongExtra("epoch", -1)
            || !owner.origin.equals(intent.getStringExtra("server_origin"))
            || owner.owner.userID != intent.getLongExtra("user_id", -1)
            || !owner.owner.sid.equals(intent.getStringExtra("sid"))) {
            if (approved != null && approved.matches(owner, intent.getLongExtra("note_id", 0))
                && approved.notificationMatches(intent.getStringExtra("generation"), intent.getLongExtra("note_id", 0))) {
                app.approvedRecording = null;
                app.publishRejected(approved.noteID, "foreground_required");
            }
            stopSelf();
            return START_NOT_STICKY;
        }
        app.approvedRecording = null;
        generation = intent.getStringExtra("generation");
        noteID = intent.getLongExtra("note_id", 0);
        rate = intent.getIntExtra("sample_rate", 0);
        connection = intent.getStringExtra("connection_id");
        language = intent.getStringExtra("language");
        background = intent.getBooleanExtra("allow_background", false);
        keepAwake = intent.getBooleanExtra("keep_awake", false);
        asrEngine = intent.getStringExtra("engine");
        if (asrEngine == null) asrEngine = "online";
        timezone = intent.getStringExtra("timezone");
        startOffset = intent.getLongExtra("start_offset_ms", 0);
        appendToArticle = intent.getBooleanExtra("append_to_article", false);
        recordingStartedAt = java.time.Instant.now().toString();
        if (noteID <= 0 || generation == null || (rate != 16000 && rate != 24000)
            || (!asrEngine.equals("local") && !asrEngine.equals("online"))
            || asrEngine.equals("local") && (rate != 16000 || !app.session.verified(owner))
            || checkSelfPermission(Manifest.permission.RECORD_AUDIO) != PackageManager.PERMISSION_GRANTED) {
            stopSelf();
            return START_NOT_STICKY;
        }
        state = "connecting";
        lease = new RecordingLease(owner, noteID, generation);
        app.recordingGeneration = generation;
        try {
            if (Build.VERSION.SDK_INT >= 30) {
                startForeground(NOTIFICATION, notification(), ServiceInfo.FOREGROUND_SERVICE_TYPE_MICROPHONE);
            } else startForeground(NOTIFICATION, notification());
        } catch (RuntimeException ignored) {
            engine.execute(() -> fail("foreground_required"));
            return START_NOT_STICKY;
        }
        startedAt = SystemClock.elapsedRealtime();
        lastSampleAt = startedAt;
        wakeRenewAt = startedAt + 5 * 60 * 1000L;
        if (background) {
            PowerManager power = getSystemService(PowerManager.class);
            wakeLock = power.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "Astering:LiveNote");
            wakeLock.setReferenceCounted(false);
            wakeLock.acquire(10 * 60 * 1000L);
        }
        engine.execute(() -> {
            publish();
            if (asrEngine.equals("local")) openLocal();
            else openWire();
        });
        engine.scheduleWithFixedDelay(this::pump, 50, 50, TimeUnit.MILLISECONDS);
        return START_NOT_STICKY;
    }

    boolean matches(SessionFence.Ticket ticket, long note) {
        return lease != null && lease.matches(ticket, note);
    }

    void stopFromPage() {
        stoppingRequested = true;
        execute(() -> {
            stopCapture();
            if (state.equals("idle") || state.equals("paused")) return;
            state = "stopping";
            publish();
            if (!asrEngine.equals("local") && !ready && audio.isEmpty()) {
                finish();
                return;
            }
            pump();
        });
    }

    void revoke() {
        stoppingRequested = true;
        execute(() -> fail("session_changed"));
    }

    void activityHidden() {
        if (!background) stopFromPage();
    }

    private void openWire() {
        if (stoppingRequested && audio.isEmpty() || !app.session.current(owner)) {
            finish();
            return;
        }
        ready = false;
        stopSent = false;
        wireSent = 0;
        long currentWire = ++wire;
        SessionFence.Ticket current = app.session.ticket();
        if (current == null || !app.session.current(owner)) {
            fail("authentication");
            return;
        }
        app.session.refresh(current.token, true, (token, refreshError) -> execute(() -> {
            if (currentWire != wire || stoppingRequested && audio.isEmpty() || !app.session.current(owner)) return;
            if (refreshError != null) {
                if (refreshError.equals("network")) recoverNetwork("network");
                else fail(refreshError);
                return;
            }
            Request request = new Request.Builder()
                .url(SitePolicy.parseServer(owner.origin).liveURL())
                .header("Origin", owner.origin)
                .build();
            socket = http.newWebSocket(request, new WebSocketListener() {
                @Override public void onOpen(WebSocket ws, Response response) {
                    execute(() -> {
                        if (!current(currentWire, ws) || stoppingRequested && audio.isEmpty()) {
                            ws.cancel();
                            return;
                        }
                        ws.send(AsteringApplication.object("action", "start", "token", token, "note_id", noteID,
                            "connection_id", connection, "language", language, "offset_ms", offset,
                            "recording_id", generation, "recording_started_at", recordingStartedAt,
                            "recording_offset_ms", totalSent * 1000L / (rate * 2L),
                            "timezone", timezone, "append_to_article", appendToArticle).toString());
                        armDeadline(currentWire, 20, "connection_timeout");
                    });
                }

                @Override public void onMessage(WebSocket ws, String text) {
                    execute(() -> handleEvent(currentWire, ws, text));
                }

                @Override public void onMessage(WebSocket ws, ByteString bytes) {
                    execute(() -> {
                        if (current(currentWire, ws)) fail("protocol");
                    });
                }

                @Override public void onFailure(WebSocket ws, Throwable failure, Response response) {
                    execute(() -> {
                        if (current(currentWire, ws)) {
                            if (response != null && (response.code() == 401 || response.code() == 403)) fail("authentication");
                            else if (response != null && response.code() == 429) fail("rate_limited");
                            else recoverNetwork("network");
                        }
                    });
                }

                @Override public void onClosing(WebSocket ws, int code, String reason) {
                    ws.close(code, null);
                    execute(() -> {
                        if (current(currentWire, ws)) recoverNetwork("interrupted");
                    });
                }
            });
            armDeadline(currentWire, 20, "connection_timeout");
        }));
    }

    private void openLocal() {
        model = LocalRecognizer.MODEL;
        endpoint = "on-device://" + LocalRecognizer.MODEL_ID;
        local = new LocalRecognizer(getAssets(), language, new LocalRecognizer.Listener() {
            @Override public void ready() { execute(() -> {
                if (stoppingRequested || !app.session.current(owner)) { if (local != null) local.abort(); finish(); return; }
                ready = true; state = "recording"; startCapture(); publish();
            }); }
            @Override public void result(String text, long startMs, long endMs, long durationMs) { execute(() -> {
                if (!app.session.current(owner)) return;
                String id = java.util.UUID.randomUUID().toString();
                JSONObject payload = AsteringApplication.object("note_id", noteID, "client_id", id, "text", text,
                    "start_ms", startOffset + startMs, "end_ms", startOffset + endMs, "timing_estimated", true,
                    "recording_id", generation, "recording_started_at", recordingStartedAt,
                    "recording_offset_ms", startMs, "captured_at", java.time.Instant.parse(recordingStartedAt).plusMillis(startMs).toString(),
                    "timezone", timezone, "append_to_article", appendToArticle);
                pendingSaves++;
                inferenceMs = durationMs;
                app.offline.save(owner, payload, (saved, code) -> execute(() -> {
                    pendingSaves--;
                    if (code != null) { partial = text; fail(code); return; }
                    localText = text; localClientID = id; savedSegments++;
                    publish();
                    if (localFinishing && pendingSaves == 0) finish();
                }));
            }); }
            @Override public void failed(String code) { execute(() -> fail(code)); }
            @Override public void finished() { execute(() -> {
                localFinishing = true;
                if (pendingSaves == 0) finish();
            }); }
        });
        publish();
    }

    private void pumpLocal() {
        long now = SystemClock.elapsedRealtime();
        if (wakeLock != null && now >= wakeRenewAt) {
            wakeLock.acquire(10 * 60 * 1000L);
            wakeRenewAt = now + 5 * 60 * 1000L;
        }
        if (!ready || local == null || localFinishing) return;
        // ASR receives at most two 100 ms frames per tick, preserving bounded catch-up.
        for (int i = 0; i < 2; i++) {
            byte[] frame = audio.pollFirst();
            if (frame == null) break;
            if (!local.accept(frame)) { partial = ""; fail("local_backpressure"); return; }
        }
        if (stoppingRequested && !reading.get() && audio.isEmpty()) local.finish();
        if (SystemClock.elapsedRealtime() - lastPublished >= 1000) publish();
    }

    private void recoverNetwork(String reason) {
        if (!app.session.current(owner)) { fail("session_changed"); return; }
        if (++retryAttempt > 5) { fail(reason); return; }
        // Already handed-off PCM may have reached the server; never replay it and create duplicate text.
        if (wireSent > 0) {
            offset += wireSent * 1000L / (rate * 2L);
            incompleteAudio = true;
            if (!partial.isEmpty()) interruptedPartial = partial;
        }
        ready = false; stopSent = false; rotating = false; wireSent = 0;
        cancelDeadline(); wire++;
        WebSocket old = socket; socket = null;
        if (old != null) old.cancel();
        state = "reconnecting";
        long delay = Math.min(2000, 200L << Math.min(retryAttempt - 1, 4));
        retryAt = SystemClock.elapsedRealtime() + delay;
        publish();
        engine.schedule(() -> { retryAt = 0; openWire(); }, delay, TimeUnit.MILLISECONDS);
    }

    private boolean current(long currentWire, WebSocket ws) {
        return currentWire == wire && socket == ws && app.session.current(owner)
            && !state.equals("idle") && !state.equals("paused");
    }

    private void handleEvent(long currentWire, WebSocket ws, String text) {
        if (!current(currentWire, ws)) return;
        if (text.length() > 262144) {
            fail("response_limit");
            return;
        }
        try {
            JSONObject event = new JSONObject(text);
            switch (event.getString("type")) {
                case "ready":
                    if (ready || event.getInt("sample_rate") != rate || event.getLong("offset_ms") < offset
                        || event.getInt("rotate_seconds") < 30 || event.getInt("rotate_seconds") > 480) {
                        fail("protocol");
                        return;
                    }
                    cancelDeadline();
                    ready = true;
                    retryAttempt = 0;
                    retryAt = 0;
                    offset = event.getLong("offset_ms");
                    rotateAt = Math.min(420, event.getInt("rotate_seconds"));
                    model = event.optString("model");
                    endpoint = event.optString("endpoint");
                    rotating = false;
                    if (stoppingRequested) {
                        state = "stopping";
                        pump();
                    } else {
                        state = "recording";
                        if (microphone == null) startCapture();
                    }
                    publish();
                    break;
                case "partial":
                    partial = event.optString("text");
                    if (partial.length() > 64000) partial = partial.substring(0, 64000);
                    publish();
                    break;
                case "segment":
                    JSONObject segment = event.getJSONObject("segment");
                    if (segment.getLong("note_id") != noteID) {
                        fail("protocol");
                        return;
                    }
                    lastSegment = segment;
                    lastStats = event.getJSONObject("stats");
                    savedSegments++;
                    partial = "";
                    publish();
                    break;
                case "done":
                    if (!stopSent) {
                        fail("protocol");
                        return;
                    }
                    cancelDeadline();
                    ready = false;
                    wire++;
                    socket = null;
                    ws.close(1000, null);
                    offset += wireSent * 1000L / (rate * 2L);
                    if (rotating && (!stoppingRequested || !audio.isEmpty()) && app.session.current(owner)) {
                        if (wakeLock != null) wakeLock.acquire(10 * 60 * 1000L);
                        openWire();
                    } else finish();
                    break;
                case "error":
                    if (event.optString("code").equals("save_failed")) partial = event.optString("text");
                    fail(knownError(event.optString("code")));
                    break;
                default:
                    fail("protocol");
            }
        } catch (Exception ignored) {
            fail("protocol");
        }
    }

    @android.annotation.SuppressLint("MissingPermission")
    private void startCapture() {
        if (stoppingRequested || !app.session.current(owner)) return;
        try {
            int frameSamples = rate / 10;
            int minimum = AudioRecord.getMinBufferSize(rate, AudioFormat.CHANNEL_IN_MONO, AudioFormat.ENCODING_PCM_16BIT);
            if (minimum <= 0) {
                fail("microphone");
                return;
            }
            AudioRecord record = new AudioRecord.Builder()
                .setAudioSource(MediaRecorder.AudioSource.MIC)
                .setAudioFormat(new AudioFormat.Builder().setSampleRate(rate)
                    .setChannelMask(AudioFormat.CHANNEL_IN_MONO).setEncoding(AudioFormat.ENCODING_PCM_16BIT).build())
                .setBufferSizeInBytes(Math.max(minimum, frameSamples * 2 * 4))
                .build();
            microphone = record;
            if (record.getState() != AudioRecord.STATE_INITIALIZED) {
                fail("microphone");
                return;
            }
            if (capturedSamples.get() == 0) {
                recordingStartedAt = java.time.Instant.now().toString();
                if (asrEngine.equals("online")) {
                    WebSocket ws = socket;
                    if (ws == null || !ws.send(AsteringApplication.object("action", "capture_started",
                        "recording_started_at", recordingStartedAt).toString())) {
                        fail("network");
                        return;
                    }
                }
            }
            record.startRecording();
            reading.set(true);
            audioThread = new Thread(() -> capture(record, frameSamples), "Astering-PCM");
            audioThread.start();
        } catch (SecurityException ignored) {
            fail("permission");
        } catch (RuntimeException ignored) {
            fail("microphone");
        }
    }

    private void capture(AudioRecord record, int frameSamples) {
        short[] frame = new short[frameSamples];
        int filled = 0;
        while (reading.get() && !stoppingRequested) {
            int count = record.read(frame, filled, frame.length - filled, AudioRecord.READ_BLOCKING);
            if (count <= 0 && (!reading.get() || stoppingRequested)) break;
            if (count <= 0) {
                execute(() -> {
                    if (microphone == record) fail("microphone");
                });
                return;
            }
            filled += count;
            capturedSamples.addAndGet(count);
            if (filled != frameSamples) continue;
            byte[] pcm = new byte[frameSamples * 2];
            ByteBuffer.wrap(pcm).order(ByteOrder.LITTLE_ENDIAN).asShortBuffer().put(frame);
            if (!audio.offerLast(pcm)) {
                reading.set(false);
                execute(() -> {
                    if (microphone == record) fail("backpressure");
                });
                return;
            }
            filled = 0;
        }
        if (filled > 0 && app.session.current(owner)) {
            byte[] pcm = new byte[filled * 2];
            ByteBuffer.wrap(pcm).order(ByteOrder.LITTLE_ENDIAN).asShortBuffer().put(frame, 0, filled);
            if (!audio.offerLast(pcm)) execute(() -> fail("backpressure"));
        }
    }

    private void pump() {
        if (state.equals("idle") || state.equals("paused")) return;
        if (!app.session.current(owner)) {
            fail("session_changed");
            return;
        }
        if (asrEngine.equals("local")) {
            pumpLocal();
            return;
        }
        WebSocket ws = socket;
        long queued = (ws == null ? 0 : ws.queueSize()) + (long) audio.size() * rate / 10 * 2;
        if (queued > rate * 2L * 4) {
            fail("backpressure");
            return;
        }
        if (!ready || ws == null || stopSent) return;
        AudioRecord record = microphone;
        if (record != null && Build.VERSION.SDK_INT >= 29) {
            android.media.AudioRecordingConfiguration config = record.getActiveRecordingConfiguration();
            if (config != null && config.isClientSilenced()) {
                fail("microphone");
                return;
            }
        }
        // One 100ms frame per 50ms tick permits bounded catch-up after a wire rotation.
        for (int i = 0; i < 1 && !rotating; i++) {
            byte[] frame = audio.pollFirst();
            if (frame == null) break;
            if (!ws.send(ByteString.of(frame))) {
                if (!audio.offerFirst(frame)) { incompleteAudio = true; fail("backpressure"); }
                else recoverNetwork("network");
                return;
            }
            wireSent += frame.length;
            totalSent += frame.length;
            if (!stoppingRequested && !rotating && wireSent >= (long) rotateAt * rate * 2) {
                rotating = true;
                state = "reconnecting";
                // The microphone keeps filling the finite RAM queue until the next wire is ready.
            }
        }
        if (rotating || stoppingRequested && !reading.get() && audio.isEmpty()) {
            stopSent = true;
            if (!ws.send("{\"action\":\"stop\"}")) {
                fail("network");
                return;
            }
            armDeadline(wire, 25, "finalize_timeout");
            publish();
        }
        long now = SystemClock.elapsedRealtime();
        if (now - lastPublished >= 1000) publish();
    }

    private synchronized void stopCapture() {
        reading.set(false);
        AudioRecord record = microphone;
        microphone = null;
        if (record == null) return;
        try {
            record.stop();
        } catch (IllegalStateException ignored) {
            // Permission revocation or device teardown may already have stopped it.
        }
        Thread reader = audioThread;
        if (reader != null && reader != Thread.currentThread()) {
            try {
                reader.join(1000);
            } catch (InterruptedException interrupted) {
                Thread.currentThread().interrupt();
            }
        }
        record.release();
        audioThread = null;
    }

    private void armDeadline(long currentWire, long seconds, String code) {
        cancelDeadline();
        deadline = engine.schedule(() -> {
            if (currentWire == wire && !state.equals("idle") && !state.equals("paused")) {
                if (code.equals("connection_timeout")) recoverNetwork(code);
                else fail(code);
            }
        }, seconds, TimeUnit.SECONDS);
    }

    private void cancelDeadline() {
        if (deadline != null) deadline.cancel(false);
        deadline = null;
    }

    private void fail(String code) {
        if (state.equals("paused") || state.equals("idle")) return;
        error = code;
        if (asrEngine.equals("local") && capturedSamples.get() > 0) incompleteAudio = true;
        state = "paused";
        closeResources();
        publish();
        stopSelf();
    }

    private void finish() {
        state = "idle";
        closeResources();
        publish();
        stopSelf();
    }

    private void closeResources() {
        stoppingRequested = true;
        stopCapture();
        audio.clear();
        if (local != null) { local.abort(); local = null; }
        cancelDeadline();
        wire++;
        WebSocket ws = socket;
        socket = null;
        if (ws != null) ws.cancel();
        if (wakeLock != null && wakeLock.isHeld()) wakeLock.release();
        stopForeground(STOP_FOREGROUND_REMOVE);
    }

    private void publish() {
        if (owner == null) return;
        long now = SystemClock.elapsedRealtime();
        if (now - lastSampleAt >= 1000) {
            bytesPerSecond = (totalSent - lastSampleBytes) * 1000d / (now - lastSampleAt);
            lastSampleAt = now;
            lastSampleBytes = totalSent;
        }
        lastPublished = now;
        WebSocket ws = socket;
        double buffered = ((ws == null ? 0 : ws.queueSize()) + (long) audio.size() * rate / 10 * 2) / (rate * 2d);
        JSONObject snapshot = AsteringApplication.object("user_id", owner.owner.userID, "sid", owner.owner.sid,
            "server_origin", owner.origin, "session_epoch", owner.epoch,
            "note_id", noteID, "generation", generation, "state", state, "partial", partial,
            "elapsed", capturedSamples.get() / (double) rate, "sent_bytes", totalSent, "bytes_per_second", bytesPerSecond,
            "buffered_seconds", buffered, "saved_segments", savedSegments, "model", model, "endpoint", endpoint,
            "allow_background", background, "keep_awake", keepAwake, "error", error, "detail", "",
            "engine", asrEngine, "local_text", localText, "local_client_id", localClientID,
            "pending_sync", pendingSaves, "inference_ms", inferenceMs, "incomplete_audio", incompleteAudio,
            "interrupted_partial", interruptedPartial, "retry_attempt", retryAttempt,
            "retry_in_seconds", Math.max(0, retryAt - now) / 1000d);
        try {
            if (lastSegment != null) snapshot.put("segment", lastSegment);
            if (lastStats != null) snapshot.put("stats", lastStats);
        } catch (org.json.JSONException impossible) {
            throw new IllegalStateException(impossible);
        }
        app.publish(this, snapshot);
        if (AsteringApplication.active(state) && now - lastNotification >= 1000) {
            lastNotification = now;
            getSystemService(NotificationManager.class).notify(NOTIFICATION, notification());
        }
    }

    private Notification notification() {
        Intent open = new Intent(this, MainActivity.class)
            .addFlags(Intent.FLAG_ACTIVITY_CLEAR_TOP | Intent.FLAG_ACTIVITY_SINGLE_TOP)
            .putExtra("note_id", noteID)
            .putExtra("user_id", owner == null ? 0 : owner.owner.userID)
            .putExtra("sid", owner == null ? "" : owner.owner.sid)
            .putExtra("server_origin", owner == null ? "" : owner.origin);
        PendingIntent openNote = PendingIntent.getActivity(this, 0, open, PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
        Intent stop = new Intent(this, RecordingService.class).setAction(STOP)
            .setData(android.net.Uri.parse("astering://recording/" + generation))
            .putExtra("generation", generation)
            .putExtra("note_id", noteID);
        PendingIntent stopRecording = PendingIntent.getService(this, 1, stop,
            PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
        int stateText = state.equals("recording") ? R.string.state_recording
            : state.equals("reconnecting") ? R.string.state_rotating
            : state.equals("stopping") ? R.string.state_stopping : R.string.state_connecting;
        Notification.Builder builder = new Notification.Builder(this, CHANNEL)
            .setSmallIcon(R.drawable.ic_recording)
            .setContentTitle(getString(R.string.recording_title))
            .setContentText(getString(R.string.recording_detail, noteID, getString(stateText)))
            .setContentIntent(openNote)
            .setOngoing(true)
            .setOnlyAlertOnce(true)
            .setCategory(Notification.CATEGORY_SERVICE)
            .setVisibility(Notification.VISIBILITY_PRIVATE)
            .addAction(new Notification.Action.Builder(null, getString(R.string.open_note), openNote).build())
            .addAction(new Notification.Action.Builder(null, getString(R.string.stop), stopRecording).build());
        if (Build.VERSION.SDK_INT >= 31) builder.setForegroundServiceBehavior(Notification.FOREGROUND_SERVICE_IMMEDIATE);
        return builder.build();
    }

    private static String knownError(String code) {
        switch (code) {
            case "authentication": case "already_recording": case "note_unavailable": case "connection":
            case "unsupported": case "save_failed": case "interrupted": case "invalid_start": case "provider":
                return code;
            default:
                return "protocol";
        }
    }

    private void execute(Runnable work) {
        if (!engine.isShutdown()) {
            try {
                engine.execute(work);
            } catch (java.util.concurrent.RejectedExecutionException ignored) {
                // Destruction owns final cleanup after the execution queue closes.
            }
        }
    }

    @Override public void onTaskRemoved(Intent rootIntent) {
        stoppingRequested = true;
        execute(() -> fail("interrupted"));
        super.onTaskRemoved(rootIntent);
    }

    @Override public void onDestroy() {
        if (AsteringApplication.active(state)) {
            state = "paused";
            error = "interrupted";
            publish();
        }
        stopCapture();
        engine.shutdownNow();
        closeResources();
        http.dispatcher().cancelAll();
        http.connectionPool().evictAll();
        if (app.recorder == this) app.recorder = null;
        super.onDestroy();
    }

    @Override public IBinder onBind(Intent intent) {
        return null;
    }
}
