package space.tcymc.astering;

import android.app.Application;
import android.os.Handler;
import android.os.Looper;
import java.lang.ref.WeakReference;
import org.json.JSONException;
import org.json.JSONObject;

public final class AsteringApplication extends Application {
    volatile SitePolicy site;
    ServerSettings servers;
    ServerChange serverChange;
    NativeSession session;
    OfflineTranscripts offline;
    OfflineModels models;
    private WeakReference<MainActivity> activity = new WeakReference<>(null);
    volatile RecordingService recorder;
    volatile String recordingGeneration = "";
    volatile RecordingLease approvedRecording;
    private final Handler main = new Handler(Looper.getMainLooper());
    private JSONObject lastSnapshot = new JSONObject();
    private final java.util.concurrent.atomic.AtomicLong sequence = new java.util.concurrent.atomic.AtomicLong();

    @Override public void onCreate() {
        super.onCreate();
        servers = new ServerSettings(this);
        site = servers.selected();
        session = new NativeSession(this);
        models = new OfflineModels(this);
        offline = new OfflineTranscripts(this);
        android.net.ConnectivityManager connectivity = getSystemService(android.net.ConnectivityManager.class);
        connectivity.registerDefaultNetworkCallback(new android.net.ConnectivityManager.NetworkCallback() {
            @Override public void onAvailable(android.net.Network network) {
                main.post(() -> { session.ensureVerified(); offline.kick(true); });
            }
        });
    }

    void selectServer(SitePolicy selected) {
        session.bindServer(null);
        site = selected;
        session.bindServer(selected);
    }

    static final class ServerChange {
        final SitePolicy selected;
        ServerChange(SitePolicy selected) { this.selected = selected; }
    }

    ServerChange beginServerChange(SitePolicy selected) {
        if (serverChange != null) throw new IllegalStateException("server_switching");
        ServerChange change = new ServerChange(selected);
        serverChange = change;
        selectServer(null);
        return change;
    }

    void completeServerChange(ServerChange expected, boolean cleaned) {
        if (serverChange != expected) return;
        boolean saved = cleaned && servers.save(expected.selected);
        if (saved) selectServer(expected.selected);
        serverChange = null;
        MainActivity current = activity.get();
        if (current != null) current.serverChangeFinished(saved ? 0
            : cleaned ? R.string.server_save_failed : R.string.server_cleanup_failed);
    }

    void attach(MainActivity value) {
        activity = new WeakReference<>(value);
    }

    void detach(MainActivity value) {
        if (activity.get() == value) activity.clear();
    }

    void stopRecordingForSessionChange() {
        RecordingService service = recorder;
        if (service != null) service.revoke();
        approvedRecording = null;
        recordingGeneration = "";
        lastSnapshot = new JSONObject();
    }

    void emit(JSONObject event) {
        MainActivity current = activity.get();
        if (current != null) current.emit(event);
    }

    void emitToken(SessionFence.Ticket owner, String token) {
        main.post(() -> {
            if (!session.current(owner)) return;
            MainActivity current = activity.get();
            if (current != null) current.emit(object("event", "token", "token", token, "server_origin", owner.origin));
        });
    }

    void publish(RecordingService source, JSONObject snapshot) {
        main.post(() -> {
            SessionFence.Ticket ticket = session.ticket();
            if (recorder != null && recorder != source || !recordingGeneration.equals(snapshot.optString("generation")) || ticket == null
                || !snapshot.optString("server_origin").equals(ticket.origin)
                || snapshot.optLong("session_epoch", -1) != ticket.epoch
                || snapshot.optLong("user_id") != ticket.owner.userID
                || !snapshot.optString("sid").equals(ticket.owner.sid)) return;
            lastSnapshot = snapshot;
            try {
                snapshot.put("sequence", sequence.incrementAndGet());
                MainActivity current = activity.get();
                snapshot.put("screen_awake", snapshot.optBoolean("keep_awake") && current != null
                    && current.isVisible() && active(snapshot.optString("state")));
            } catch (JSONException impossible) {
                throw new IllegalStateException(impossible);
            }
            MainActivity current = activity.get();
            if (current != null) {
                current.setScreenAwake(snapshot.optBoolean("keep_awake") && active(snapshot.optString("state")));
                current.emit(object("event", "recording", "snapshot", snapshot));
            }
        });
    }

    JSONObject snapshot() {
        SessionFence.Ticket ticket = session.ticket();
        if (ticket == null) return object("state", "idle", "sequence", sequence.get(), "note_id", 0);
        if (lastSnapshot.optString("server_origin").equals(ticket.origin)
            && lastSnapshot.optLong("session_epoch", -1) == ticket.epoch
            && lastSnapshot.optLong("user_id") == ticket.owner.userID
            && lastSnapshot.optString("sid").equals(ticket.owner.sid)) return lastSnapshot;
        return object("state", "idle", "user_id", ticket.owner.userID, "sid", ticket.owner.sid,
            "note_id", 0, "sequence", sequence.get(), "allow_background", false,
            "server_origin", ticket.origin, "session_epoch", ticket.epoch);
    }

    boolean canStartRecording() {
        MainActivity current = activity.get();
        return current != null && current.isRecordingStartAllowed();
    }

    void publishIdle(long noteID) {
        publishRejected(noteID, "");
    }

    void publishRejected(long noteID, String error) {
        SessionFence.Ticket owner = session.ticket();
        if (owner == null) return;
        lastSnapshot = object("state", error.isEmpty() ? "idle" : "paused", "error", error,
            "user_id", owner.owner.userID, "sid", owner.owner.sid,
            "note_id", noteID, "sequence", sequence.incrementAndGet(), "allow_background", false,
            "server_origin", owner.origin, "session_epoch", owner.epoch);
        MainActivity current = activity.get();
        if (current != null) current.emit(object("event", "recording", "snapshot", lastSnapshot));
    }

    static boolean active(String state) {
        return state.equals("connecting") || state.equals("recording") || state.equals("reconnecting") || state.equals("stopping");
    }

    static JSONObject object(Object... pairs) {
        JSONObject out = new JSONObject();
        try {
            for (int i = 0; i < pairs.length; i += 2) out.put((String) pairs[i], pairs[i + 1]);
        } catch (JSONException impossible) {
            throw new IllegalArgumentException("invalid_json", impossible);
        }
        return out;
    }
}
