package space.tcymc.astering;

import android.app.Application;
import android.os.Handler;
import android.os.Looper;
import java.lang.ref.WeakReference;
import org.json.JSONException;
import org.json.JSONObject;

public final class AsteringApplication extends Application {
    NativeSession session;
    private WeakReference<MainActivity> activity = new WeakReference<>(null);
    volatile RecordingService recorder;
    volatile String recordingGeneration = "";
    volatile RecordingLease approvedRecording;
    private final Handler main = new Handler(Looper.getMainLooper());
    private JSONObject lastSnapshot = new JSONObject();
    private final java.util.concurrent.atomic.AtomicLong sequence = new java.util.concurrent.atomic.AtomicLong();

    @Override public void onCreate() {
        super.onCreate();
        session = new NativeSession(this);
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

    void emitToken(String token) {
        main.post(() -> {
            MainActivity current = activity.get();
            if (current != null) current.emit(object("event", "token", "token", token));
        });
    }

    void publish(RecordingService source, JSONObject snapshot) {
        main.post(() -> {
            SessionFence.Ticket ticket = session.ticket();
            if (recorder != null && recorder != source || !recordingGeneration.equals(snapshot.optString("generation")) || ticket == null
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
        if (lastSnapshot.optLong("user_id") == ticket.owner.userID
            && lastSnapshot.optString("sid").equals(ticket.owner.sid)) return lastSnapshot;
        return object("state", "idle", "user_id", ticket.owner.userID, "sid", ticket.owner.sid,
            "note_id", 0, "sequence", sequence.get(), "allow_background", false);
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
            "note_id", noteID, "sequence", sequence.incrementAndGet(), "allow_background", false);
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
