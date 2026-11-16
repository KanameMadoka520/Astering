package space.tcymc.astering;

import java.time.Instant;
import java.util.ArrayList;
import java.util.Collections;
import java.util.List;
import org.json.JSONArray;
import org.json.JSONObject;

/** A bounded projection, never a copy of the task database or arbitrary notification payloads. */
final class NotificationSnapshot {
    static final int MAX_BYTES = 768 * 1024;
    static final int MAX_REMINDERS = 512;
    final long userID;
    final long generatedAt;
    final long validUntil;
    final long horizonEnd;
    final long unread;
    final long personalOpen;
    final long overdue;
    final long dueInWindow;
    final long upcoming;
    final long newestNotification;
    final boolean remindersComplete;
    final boolean notificationsComplete;
    final List<Reminder> reminders;
    final List<Long> notifications;
    final java.util.Map<Long, String> notificationReminders;
    final String timezone;

    private NotificationSnapshot(JSONObject raw, long expectedUser, boolean preview) throws Exception {
        if (raw.getInt("schema_version") != 1 || raw.getLong("user_id") != expectedUser || expectedUser <= 0)
            throw new IllegalArgumentException("protocol");
        userID = expectedUser;
        generatedAt = instant(raw.getString("generated_at"));
        validUntil = instant(raw.getString("valid_until"));
        horizonEnd = instant(raw.getString("horizon_end"));
        if (validUntil <= generatedAt || validUntil - generatedAt > 24 * 3600_000L + 60_000
            || horizonEnd < generatedAt || horizonEnd - generatedAt > 8 * 24 * 3600_000L)
            throw new IllegalArgumentException("protocol");
        JSONObject counts = raw.getJSONObject("counts");
        unread = count(counts, "unread_notifications");
        personalOpen = count(counts, "personal_open");
        overdue = count(counts, "overdue");
        dueInWindow = count(counts, "due_in_window");
        upcoming = count(counts, "upcoming");
        timezone = raw.optString("timezone", "UTC");
        java.time.ZoneId.of(timezone);
        newestNotification = count(raw, "newest_notification_id");
        remindersComplete = raw.getBoolean("reminders_complete");
        notificationsComplete = raw.getBoolean("notifications_complete");
        JSONArray remindersRaw = raw.getJSONArray("reminders");
        JSONArray notificationsRaw = raw.getJSONArray("notifications");
        if (remindersRaw.length() > MAX_REMINDERS || notificationsRaw.length() > 50)
            throw new IllegalArgumentException("response_limit");
        ArrayList<Reminder> nextReminders = new ArrayList<>();
        java.util.HashSet<String> keys = new java.util.HashSet<>();
        for (int i = 0; i < remindersRaw.length(); i++) {
            Reminder reminder = new Reminder(remindersRaw.getJSONObject(i), preview);
            if (reminder.triggerAt < generatedAt || reminder.triggerAt > horizonEnd || !keys.add(reminder.eventKey()))
                throw new IllegalArgumentException("protocol");
            nextReminders.add(reminder);
        }
        reminders = Collections.unmodifiableList(nextReminders);
        ArrayList<Long> nextNotifications = new ArrayList<>();
        java.util.HashMap<Long, String> events = new java.util.HashMap<>();
        for (int i = 0; i < notificationsRaw.length(); i++) {
            JSONObject notification = notificationsRaw.getJSONObject(i);
            long value = positive(notification.getLong("id"));
            if (value > newestNotification || nextNotifications.contains(value)) throw new IllegalArgumentException("protocol");
            nextNotifications.add(value);
            if ("task.reminder".equals(notification.optString("name")) && notification.has("reminder_key")
                && notification.has("reminder_trigger_at")) {
                String key = notification.optString("reminder_key");
                if (!key.isEmpty() && key.length() <= 160 && key.matches("[A-Za-z0-9:_./-]+")) {
                    try { events.put(value, key + "@" + instant(notification.getString("reminder_trigger_at"))); }
                    catch (Exception invalidMetadata) { /* Old or invalid metadata uses a generic new-message alert. */ }
                }
            }
        }
        notifications = Collections.unmodifiableList(nextNotifications);
        notificationReminders = Collections.unmodifiableMap(events);
    }

    static NotificationSnapshot parse(JSONObject raw, long user, boolean preview) throws Exception {
        return new NotificationSnapshot(raw, user, preview);
    }

    static long instant(String value) {
        long result = Instant.parse(value).toEpochMilli();
        if (result <= 0) throw new IllegalArgumentException("protocol");
        return result;
    }

    static long positive(long value) {
        if (value <= 0 || value > 9_007_199_254_740_991L) throw new IllegalArgumentException("protocol");
        return value;
    }

    private static long count(JSONObject value, String name) throws Exception {
        long result = value.getLong(name);
        if (result < 0 || result > 9_007_199_254_740_991L) throw new IllegalArgumentException("protocol");
        return result;
    }

    static final class Reminder {
        final String key;
        final long taskID;
        final long triggerAt;
        final String title;
        final String source;
        Reminder(JSONObject value, boolean preview) throws Exception {
            key = value.getString("key");
            if (key.isEmpty() || key.length() > 160 || !key.matches("[A-Za-z0-9:_./-]+"))
                throw new IllegalArgumentException("protocol");
            taskID = positive(value.getLong("task_id"));
            triggerAt = instant(value.getString("trigger_at"));
            source = value.optString("source", "explicit");
            if (!source.equals("explicit") && !source.equals("start") && !source.equals("due"))
                throw new IllegalArgumentException("protocol");
            String supplied = value.optString("title", "");
            title = preview ? supplied.substring(0, Math.min(300, supplied.length())).replaceAll("[\\p{Cntrl}&&[^\\n\\t]]", "") : "";
        }
        String eventKey() { return key + "@" + triggerAt; }
        boolean dateDerived() { return !source.equals("explicit"); }
        long alarmAt(int leadMinutes) { return triggerAt - (dateDerived() ? leadMinutes * 60_000L : 0); }
        JSONObject json() {
            return AsteringApplication.object("key", key, "task_id", taskID, "trigger_at", Instant.ofEpochMilli(triggerAt).toString(),
                "title", title, "source", source);
        }
    }
}
