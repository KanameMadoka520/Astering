package space.tcymc.astering;

import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import org.json.JSONArray;
import org.json.JSONObject;

/** Bounded, persistable state and a monotonic server clock. No Android scheduling side effects. */
final class NotificationState {
    final NotificationGrant grant;
    boolean preview;
    boolean exact;
    boolean taskReminders = true;
    boolean dateReminders = true;
    int dateLeadMinutes = 15;
    boolean baseline;
    long watermark;
    long unread;
    long personalOpen;
    long overdue;
    long dueInWindow;
    long upcoming;
    long syncedWall;
    long serverAtSync;
    long lastSnapshotGeneratedAt;
    long elapsedAtSync;
    int bootAtSync = -1;
    long validUntil;
    String error = "";
    String timezone = "UTC";
    String lastSummaryDay = "";
    final LinkedHashMap<String, PendingReminder> reminders = new LinkedHashMap<>();
    final LinkedHashMap<String, Long> delivered = new LinkedHashMap<>();

    NotificationState(NotificationGrant grant, boolean preview) { this.grant = grant; this.preview = preview; }

    /** Unknown reboot clock invalidates cached alerts until the next authenticated server snapshot. */
    boolean clockTrusted(long elapsed, int boot) {
        return serverAtSync > 0 && boot >= 0 && bootAtSync == boot && elapsed >= elapsedAtSync;
    }
    long serverNow(long elapsed, int boot) {
        return clockTrusted(elapsed, boot) ? serverAtSync + elapsed - elapsedAtSync : Long.MAX_VALUE;
    }
    boolean valid(long elapsed, int boot) {
        long now = serverNow(elapsed, boot);
        return now < validUntil && now < grant.expiresAt;
    }

    /** Returns true only for genuinely new unread metadata after an established initial watermark. */
    boolean apply(NotificationSnapshot snapshot, long wall, long elapsed, int boot) {
        if (snapshot.userID != grant.userID || snapshot.generatedAt >= grant.expiresAt)
            throw new IllegalArgumentException("authentication");
        if (snapshot.generatedAt < lastSnapshotGeneratedAt) throw new IllegalArgumentException("protocol");
        long acceptedNow = clockTrusted(elapsed, boot) ? Math.max(snapshot.generatedAt, serverNow(elapsed, boot)) : snapshot.generatedAt;
        boolean notify = false;
        if (baseline) for (long id : snapshot.notifications) {
            if (id <= watermark) continue;
            String reminderEvent = snapshot.notificationReminders.get(id);
            if (reminderEvent == null || !delivered.containsKey(reminderEvent)) notify = true;
            if (reminderEvent != null) delivered.put(reminderEvent, acceptedNow);
        }
        watermark = Math.max(watermark, snapshot.newestNotification);
        baseline = true; // Includes an empty initial inbox; do not baseline again after its first notification.
        unread = snapshot.unread;
        personalOpen = snapshot.personalOpen;
        overdue = snapshot.overdue;
        dueInWindow = snapshot.dueInWindow;
        upcoming = snapshot.upcoming;
        syncedWall = wall;
        serverAtSync = acceptedNow;
        lastSnapshotGeneratedAt = snapshot.generatedAt;
        timezone = snapshot.timezone;
        elapsedAtSync = elapsed;
        bootAtSync = boot;
        validUntil = Math.min(snapshot.validUntil, grant.expiresAt);
        error = "";
        if (snapshot.remindersComplete) reminders.clear();
        reminders.entrySet().removeIf(entry -> entry.getValue().validUntil <= snapshot.generatedAt
            || entry.getValue().reminder.triggerAt < snapshot.generatedAt - 3600_000L);
        for (NotificationSnapshot.Reminder reminder : snapshot.reminders) {
            if (!reminders.containsKey(reminder.key) && reminders.size() >= NotificationSnapshot.MAX_REMINDERS) {
                error = "partial";
                continue;
            }
            reminders.put(reminder.key, new PendingReminder(reminder, validUntil));
        }
        if (!snapshot.remindersComplete) error = "partial";
        delivered.entrySet().removeIf(entry -> entry.getValue() < snapshot.generatedAt - 8 * 24 * 3600_000L);
        while (delivered.size() > 2048) delivered.remove(delivered.keySet().iterator().next());
        return notify;
    }

    List<NotificationSnapshot.Reminder> takeDue(long elapsed, int boot) {
        ArrayList<NotificationSnapshot.Reminder> due = new ArrayList<>();
        if (!valid(elapsed, boot)) return due;
        long now = serverNow(elapsed, boot);
        for (PendingReminder pending : reminders.values()) {
            NotificationSnapshot.Reminder item = pending.reminder;
            if (item.dateDerived() ? !dateReminders : !taskReminders) continue;
            long alarmAt = item.alarmAt(dateLeadMinutes);
            if (alarmAt > now || pending.validUntil <= now || delivered.containsKey(item.eventKey())) continue;
            // A badly delayed alarm must not replay a day of obsolete reminders on waking.
            delivered.put(item.eventKey(), now);
            if (now - alarmAt <= 3600_000L) due.add(item);
        }
        while (delivered.size() > 2048) delivered.remove(delivered.keySet().iterator().next());
        return due;
    }

    long nextAlarm(long elapsed, int boot) {
        if (!valid(elapsed, boot)) return 0;
        long now = serverNow(elapsed, boot);
        long next = Math.min(validUntil, grant.expiresAt); // Also wake once to clear stale private notifications.
        for (PendingReminder pending : reminders.values()) {
            NotificationSnapshot.Reminder item = pending.reminder;
            if (item.dateDerived() ? !dateReminders : !taskReminders) continue;
            long alarmAt = item.alarmAt(dateLeadMinutes);
            if (pending.validUntil <= now || alarmAt >= pending.validUntil || delivered.containsKey(item.eventKey())) continue;
            next = Math.min(next, Math.max(now + 1000, alarmAt));
        }
        return elapsed + Math.max(1000, next - now);
    }

    void hidePreviews() {
        preview = false;
        try {
            for (java.util.Map.Entry<String, PendingReminder> entry : reminders.entrySet()) {
                entry.setValue(new PendingReminder(new NotificationSnapshot.Reminder(entry.getValue().reminder.json(), false),
                    entry.getValue().validUntil));
            }
        } catch (Exception impossible) { throw new IllegalStateException(impossible); }
    }

    JSONObject json() {
        JSONArray alarmValues = new JSONArray();
        for (PendingReminder pending : reminders.values()) alarmValues.put(AsteringApplication.object("reminder",
            pending.reminder.json(), "valid_until", pending.validUntil));
        JSONObject ledger = new JSONObject();
        try { for (java.util.Map.Entry<String, Long> entry : delivered.entrySet()) ledger.put(entry.getKey(), entry.getValue()); }
        catch (org.json.JSONException impossible) { throw new IllegalStateException(impossible); }
        return AsteringApplication.object("version", 1, "grant", grant.json(), "preview", preview, "exact", exact,
            "task_reminders", taskReminders, "date_reminders", dateReminders, "date_lead", dateLeadMinutes,
            "baseline", baseline, "watermark", watermark, "unread", unread,
            "personal_open", personalOpen, "overdue", overdue, "due_in_window", dueInWindow, "upcoming", upcoming, "synced_wall", syncedWall,
            "server_at_sync", serverAtSync, "elapsed_at_sync", elapsedAtSync, "boot_at_sync", bootAtSync,
            "last_snapshot_generated_at", lastSnapshotGeneratedAt, "timezone", timezone, "last_summary_day", lastSummaryDay,
            "valid_until", validUntil, "error", error, "reminders", alarmValues, "delivered", ledger);
    }

    static NotificationState restore(JSONObject value) throws Exception {
        if (value.getInt("version") != 1) throw new IllegalArgumentException("local_storage");
        NotificationState state = new NotificationState(NotificationGrant.restore(value.getJSONObject("grant")), value.getBoolean("preview"));
        state.exact = value.getBoolean("exact");
        state.taskReminders = value.getBoolean("task_reminders");
        state.dateReminders = value.optBoolean("date_reminders", true);
        state.dateLeadMinutes = value.optInt("date_lead", 15);
        if (state.dateLeadMinutes < 0 || state.dateLeadMinutes > 60) throw new IllegalArgumentException("local_storage");
        state.baseline = value.getBoolean("baseline");
        state.watermark = value.getLong("watermark");
        state.unread = value.getLong("unread");
        state.personalOpen = value.getLong("personal_open");
        state.overdue = value.getLong("overdue");
        state.dueInWindow = value.optLong("due_in_window");
        state.upcoming = value.getLong("upcoming");
        state.syncedWall = value.getLong("synced_wall");
        state.serverAtSync = value.getLong("server_at_sync");
        state.lastSnapshotGeneratedAt = value.optLong("last_snapshot_generated_at", state.serverAtSync);
        state.timezone = value.optString("timezone", "UTC");
        java.time.ZoneId.of(state.timezone);
        state.lastSummaryDay = value.optString("last_summary_day", "");
        state.elapsedAtSync = value.getLong("elapsed_at_sync");
        state.bootAtSync = value.getInt("boot_at_sync");
        state.validUntil = Math.min(value.getLong("valid_until"), state.grant.expiresAt);
        String error = value.optString("error");
        state.error = error.matches("[a-z_]{0,40}") ? error : "server";
        JSONArray reminders = value.getJSONArray("reminders");
        JSONObject delivered = value.getJSONObject("delivered");
        if (reminders.length() > NotificationSnapshot.MAX_REMINDERS || delivered.length() > 2048)
            throw new IllegalArgumentException("local_storage");
        for (int i = 0; i < reminders.length(); i++) {
            JSONObject item = reminders.getJSONObject(i);
            NotificationSnapshot.Reminder reminder = new NotificationSnapshot.Reminder(item.getJSONObject("reminder"), state.preview);
            state.reminders.put(reminder.key, new PendingReminder(reminder, Math.min(item.getLong("valid_until"), state.grant.expiresAt)));
        }
        java.util.Iterator<String> keys = delivered.keys();
        while (keys.hasNext()) {
            String key = keys.next();
            if (key.length() > 190) throw new IllegalArgumentException("local_storage");
            state.delivered.put(key, delivered.getLong(key));
        }
        return state;
    }

    static final class PendingReminder {
        final NotificationSnapshot.Reminder reminder;
        final long validUntil;
        PendingReminder(NotificationSnapshot.Reminder reminder, long validUntil) {
            this.reminder = reminder; this.validUntil = validUntil;
        }
    }
}
