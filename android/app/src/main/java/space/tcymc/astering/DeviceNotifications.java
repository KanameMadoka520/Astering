package space.tcymc.astering;

import android.app.AlarmManager;
import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.content.Context;
import android.content.Intent;
import android.net.Uri;
import android.os.Build;
import android.os.SystemClock;
import android.provider.Settings;
import androidx.core.app.NotificationCompat;
import androidx.work.BackoffPolicy;
import androidx.work.Constraints;
import androidx.work.ExistingPeriodicWorkPolicy;
import androidx.work.ExistingWorkPolicy;
import androidx.work.NetworkType;
import androidx.work.OneTimeWorkRequest;
import androidx.work.PeriodicWorkRequest;
import androidx.work.WorkManager;
import java.time.Instant;
import java.util.List;
import java.util.UUID;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicBoolean;
import org.json.JSONObject;

/** One coordinator serializes local grant changes, snapshot commits, alarms and notification publication. */
final class DeviceNotifications {
    static final String OPEN = "space.tcymc.astering.OPEN_NOTIFICATION";
    static final String TICK = "space.tcymc.astering.NOTIFICATION_TICK";
    private static final String WORK = "device-notifications-v1";
    private static final String SYNC = WORK + "-sync";
    private static final String INBOX_CHANNEL = "device-inbox-v1";
    private static final String REMINDER_CHANNEL = "device-task-reminders-v1";
    private static final String TAG = "astering-device-notifications";
    private final AsteringApplication app;
    private final NotificationStore store;
    private final NotificationApi api = new NotificationApi();
    private final java.util.concurrent.ExecutorService actions = java.util.concurrent.Executors.newSingleThreadExecutor();
    private final AtomicBoolean syncing = new AtomicBoolean();
    private NotificationState state;
    private String authorization = "";
    private String lastError = "";
    private long lastSyncRequest;

    DeviceNotifications(AsteringApplication app) {
        this.app = app;
        store = new NotificationStore(app);
        state = store.read();
        if (state != null && (app.site == null || !state.grant.origin.equals(app.site.origin))) clearLocal();
        channels();
        if (state != null && !state.valid(SystemClock.elapsedRealtime(), boot())) cancelNotifications();
        if (state != null) { schedulePeriodic(); scheduleAlarm(); }
    }

    synchronized void ownerChanged(SessionFence.Ticket owner) {
        if (state != null && (owner == null || owner.owner.userID != state.grant.userID || !owner.origin.equals(state.grant.origin)))
            clearLocal();
        if (!authorization.isEmpty()) { authorization = ""; api.cancel(); }
    }

    /** Explicit clearSession is distinct from an empty in-memory session during a cold process start. */
    void loggedOut(SessionFence.Ticket previous) {
        NotificationGrant grant;
        synchronized (this) { grant = state == null ? null : state.grant; clearLocal(); }
        if (grant != null && previous != null && previous.owner.userID == grant.userID && previous.origin.equals(grant.origin)) {
            actions.execute(() -> { try { new NotificationApi().revoke(grant, previous.token); }
                catch (Exception ignored) { /* Offline or already-revoked login: API-token settings remain available. */ } });
        }
    }

    void enable(SessionFence.Ticket owner, boolean preview) {
        final String attempt;
        synchronized (this) {
            if (owner == null || !app.session.verified(owner) || app.site == null || !owner.origin.equals(app.site.origin)) {
                lastError = "authentication"; return;
            }
            if (!authorization.isEmpty()) return;
            attempt = UUID.randomUUID().toString();
            authorization = attempt;
            lastError = "";
        }
        actions.execute(() -> {
            try {
                String installation = installation();
                String device = (Build.MANUFACTURER + " " + Build.MODEL).trim();
                JSONObject result = api.issue(owner.origin, owner.token, installation,
                    device.substring(0, Math.min(device.length(), 80)));
                NotificationGrant grant = NotificationGrant.issued(owner.origin, owner.owner.userID, result);
                synchronized (this) {
                    if (!attempt.equals(authorization) || !app.session.verified(owner) || app.site == null
                        || !owner.origin.equals(app.site.origin)) return;
                    clearLocal();
                    state = new NotificationState(grant, preview);
                    try { store.activate(state); }
                    catch (Exception unavailable) { clearLocal(); lastError = "local_storage"; return; }
                    schedulePeriodic();
                    requestSync(true);
                }
            } catch (Exception error) {
                synchronized (this) { if (attempt.equals(authorization)) lastError = errorCode(error); }
            } finally {
                synchronized (this) { if (attempt.equals(authorization)) authorization = ""; }
            }
        });
    }

    void disable(boolean revoke) {
        NotificationGrant grant;
        SessionFence.Ticket owner = app.session.ticket();
        synchronized (this) { grant = state == null ? null : state.grant; clearLocal(); }
        if (revoke && grant != null && owner != null && app.session.verified(owner)
            && owner.owner.userID == grant.userID && owner.origin.equals(grant.origin)) {
            // Local shutdown has completed already. This independent best-effort request never restores state.
            actions.execute(() -> { try { if (app.session.current(owner)) new NotificationApi().revoke(grant, owner.token); }
                catch (Exception ignored) { /* API-token settings remain the authoritative remote revoke entry. */ } });
        }
    }

    synchronized void preferences(boolean preview, boolean reminders, boolean dates, int lead, boolean exact) {
        if (state == null) return;
        if (!preview) { state.hidePreviews(); cancelNotifications(); }
        else state.preview = true;
        state.taskReminders = reminders;
        state.dateReminders = dates;
        state.dateLeadMinutes = Math.max(0, Math.min(60, lead));
        state.exact = exact;
        if (persist()) { scheduleAlarm(); requestSync(false); }
    }

    synchronized void requestSync(boolean explicit) {
        if (state == null) return;
        long elapsed = SystemClock.elapsedRealtime();
        if (!explicit && elapsed - lastSyncRequest < 30_000) return;
        lastSyncRequest = elapsed;
        WorkManager.getInstance(app).enqueueUniqueWork(SYNC, ExistingWorkPolicy.KEEP,
            new OneTimeWorkRequest.Builder(NotificationSyncWorker.class)
                .setConstraints(new Constraints.Builder().setRequiredNetworkType(NetworkType.CONNECTED).build())
                .setBackoffCriteria(BackoffPolicy.EXPONENTIAL, 30, TimeUnit.SECONDS).build());
    }

    /** Worker thread only. A response may be applied only while its exact durable generation still owns the coordinator. */
    boolean sync() {
        final NotificationGrant grant;
        synchronized (this) { if (state == null) return true; grant = state.grant; }
        if (!syncing.compareAndSet(false, true)) return false;
        try {
            JSONObject response = api.snapshot(grant);
            synchronized (this) {
                if (!current(grant.generation)) return true;
                NotificationSnapshot snapshot = NotificationSnapshot.parse(response, grant.userID, state.preview);
                boolean newUnread = state.apply(snapshot, System.currentTimeMillis(), SystemClock.elapsedRealtime(), boot());
                lastError = "";
                if (!persist()) return true;
                if (state.unread == 0) manager().cancel(TAG, 7301);
                else inbox(newUnread);
                deliverDue();
                overdueSummary();
                scheduleAlarm();
            }
            return true;
        } catch (Exception error) {
            synchronized (this) {
                if (!current(grant.generation)) return true;
                String code = errorCode(error);
                if (code.equals("authentication")) { clearLocal(); lastError = "authentication"; return true; }
                state.error = code;
                persist();
                lastError = code;
            }
            return false;
        } finally { syncing.set(false); }
    }

    synchronized void tick(Intent intent) {
        if (state == null || !matches(intent) || !current(state.grant.generation)) return;
        if (!state.valid(SystemClock.elapsedRealtime(), boot())) {
            cancelNotifications(); cancelAlarm(state.grant.generation);
            if (state.clockTrusted(SystemClock.elapsedRealtime(), boot())
                && state.serverNow(SystemClock.elapsedRealtime(), boot()) >= state.grant.expiresAt) {
                clearLocal(); lastError = "expired";
            } else requestSync(false);
            return;
        }
        deliverDue();
        scheduleAlarm();
    }

    synchronized void reschedule() {
        if (state == null) return;
        if (!state.valid(SystemClock.elapsedRealtime(), boot())) cancelNotifications();
        scheduleAlarm(); requestSync(false);
    }

    synchronized boolean matches(Intent intent) {
        if (state == null || intent == null) return false;
        Uri expected = identityURI(state.grant.generation, "tap");
        return state.grant.generation.equals(intent.getStringExtra("notification_generation"))
            && state.grant.origin.equals(intent.getStringExtra("server_origin"))
            && state.grant.userID == intent.getLongExtra("user_id", -1)
            && intent.getData() != null && (expected.equals(intent.getData())
                || identityURI(state.grant.generation, "tick").equals(intent.getData()));
    }

    synchronized JSONObject target(Intent intent, SessionFence.Ticket owner) {
        if (state == null || !matches(intent) || !state.valid(SystemClock.elapsedRealtime(), boot()) || owner == null
            || !app.session.verified(owner) || owner.owner.userID != state.grant.userID || !owner.origin.equals(state.grant.origin)) return null;
        NotificationTarget target = NotificationTarget.parse(intent.getStringExtra("resource_kind"), intent.getStringExtra("resource_id"));
        return target == null ? null : target.json();
    }

    synchronized JSONObject status() {
        boolean enabled = state != null;
        return AsteringApplication.object("enabled", enabled, "authorizing", !authorization.isEmpty(), "busy", !authorization.isEmpty() || syncing.get(),
            "preview", enabled && state.preview, "task_reminders", !enabled || state.taskReminders, "exact", enabled && state.exact,
            "date_reminders", !enabled || state.dateReminders, "date_lead", enabled ? state.dateLeadMinutes : 15,
            "exact_allowed", exactAllowed(), "user_id", enabled ? state.grant.userID : 0,
            "expires_at", enabled ? state.grant.expiresAt : 0, "last_sync", enabled ? state.syncedWall : 0,
            "unread", enabled ? state.unread : 0, "reminders", enabled ? state.reminders.size() : 0,
            "overdue", enabled ? state.overdue : 0, "upcoming", enabled ? state.upcoming : 0,
            "due_in_window", enabled ? state.dueInWindow : 0,
            "error", !lastError.isEmpty() ? lastError : enabled ? state.error : "");
    }

    synchronized void test() {
        if (state == null) return;
        show(7303, REMINDER_CHANNEL, app.getString(R.string.notifications_test_title), app.getString(R.string.notifications_test_body),
            NotificationTarget.parse("notifications", ""), true, 0);
    }

    boolean exactAllowed() {
        return Build.VERSION.SDK_INT < 31 || app.getSystemService(AlarmManager.class).canScheduleExactAlarms();
    }

    private void deliverDue() {
        List<NotificationSnapshot.Reminder> due = state.takeDue(SystemClock.elapsedRealtime(), boot());
        if (due.isEmpty() || !persist()) return;
        NotificationSnapshot.Reminder first = due.get(0);
        String text = state.preview && due.size() == 1 && !first.title.isEmpty() ? first.title
            : app.getString(R.string.notifications_task_count, due.size());
        show(7302, REMINDER_CHANNEL, app.getString(R.string.notifications_task_title), text,
            due.size() == 1 ? NotificationTarget.parse("task", Long.toString(first.taskID)) : NotificationTarget.parse("notifications", ""),
            true, 0);
    }

    private void inbox(boolean alert) {
        show(7301, INBOX_CHANNEL, app.getString(R.string.notifications_inbox_title),
            app.getString(R.string.notifications_unread, state.unread), NotificationTarget.parse("notifications", ""), alert,
            (int) Math.min(Integer.MAX_VALUE, state.unread));
    }

    private void overdueSummary() {
        if (state == null || !state.dateReminders || state.overdue == 0 || !state.valid(SystemClock.elapsedRealtime(), boot())) return;
        String day = java.time.Instant.ofEpochMilli(state.serverNow(SystemClock.elapsedRealtime(), boot()))
            .atZone(java.time.ZoneId.of(state.timezone)).toLocalDate().toString();
        if (day.equals(state.lastSummaryDay)) return;
        state.lastSummaryDay = day;
        if (!persist()) return;
        show(7304, REMINDER_CHANNEL, app.getString(R.string.notifications_overdue_title),
            app.getString(R.string.notifications_overdue_body, state.overdue), NotificationTarget.parse("notifications", ""), true, 0);
    }

    private void show(int id, String channel, String title, String body, NotificationTarget target, boolean alert, int count) {
        if (state == null || target == null || !manager().areNotificationsEnabled()) return;
        Intent open = new Intent(app, MainActivity.class).setAction(OPEN).setData(identityURI(state.grant.generation, "tap"))
            .addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP | Intent.FLAG_ACTIVITY_CLEAR_TOP)
            .putExtra("notification_generation", state.grant.generation).putExtra("server_origin", state.grant.origin)
            .putExtra("user_id", state.grant.userID).putExtra("resource_kind", target.kind).putExtra("resource_id", target.id);
        // IDs separate notification kinds; URI generation prevents reuse by a later login/grant.
        PendingIntent tap = PendingIntent.getActivity(app, id, open, PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
        Notification publicVersion = new NotificationCompat.Builder(app, channel).setSmallIcon(R.drawable.ic_notification)
            .setContentTitle(app.getString(R.string.app_name)).setContentText(app.getString(R.string.notifications_private)).build();
        NotificationCompat.Builder builder = new NotificationCompat.Builder(app, channel).setSmallIcon(R.drawable.ic_notification)
            .setContentTitle(title).setContentText(body).setContentIntent(tap).setAutoCancel(true)
            .setVisibility(NotificationCompat.VISIBILITY_PRIVATE).setPublicVersion(publicVersion).setNumber(count)
            .setOnlyAlertOnce(!alert).setGroup(TAG).setGroupSummary(id == 7301);
        if (!alert) builder.setSilent(true);
        try { manager().notify(TAG, id, builder.build()); }
        catch (SecurityException denied) { lastError = "notification_permission"; }
    }

    private void schedulePeriodic() {
        WorkManager.getInstance(app).enqueueUniquePeriodicWork(WORK, ExistingPeriodicWorkPolicy.KEEP,
            new PeriodicWorkRequest.Builder(NotificationSyncWorker.class, 15, TimeUnit.MINUTES)
                .setConstraints(new Constraints.Builder().setRequiredNetworkType(NetworkType.CONNECTED).build())
                .setBackoffCriteria(BackoffPolicy.EXPONENTIAL, 30, TimeUnit.SECONDS).build());
    }

    private void scheduleAlarm() {
        if (state == null) return;
        AlarmManager alarms = app.getSystemService(AlarmManager.class);
        PendingIntent pending = alarmIntent(state.grant.generation, PendingIntent.FLAG_UPDATE_CURRENT);
        alarms.cancel(pending);
        long trigger = state.nextAlarm(SystemClock.elapsedRealtime(), boot());
        if (trigger <= 0) return;
        try {
            if (state.exact && exactAllowed()) alarms.setExactAndAllowWhileIdle(AlarmManager.ELAPSED_REALTIME_WAKEUP, trigger, pending);
            else alarms.setAndAllowWhileIdle(AlarmManager.ELAPSED_REALTIME_WAKEUP, trigger, pending);
        } catch (SecurityException revoked) {
            alarms.setAndAllowWhileIdle(AlarmManager.ELAPSED_REALTIME_WAKEUP, trigger, pending);
        }
    }

    private PendingIntent alarmIntent(String generation, int flags) {
        Intent intent = new Intent(app, TaskReminderReceiver.class).setAction(TICK).setData(identityURI(generation, "tick"))
            .putExtra("notification_generation", generation).putExtra("server_origin", state.grant.origin)
            .putExtra("user_id", state.grant.userID);
        return PendingIntent.getBroadcast(app, 7300, intent, flags | PendingIntent.FLAG_IMMUTABLE);
    }
    private void cancelAlarm(String generation) {
        if (state == null) return;
        PendingIntent alarm = alarmIntent(generation, PendingIntent.FLAG_NO_CREATE);
        if (alarm != null) { app.getSystemService(AlarmManager.class).cancel(alarm); alarm.cancel(); }
    }
    private void cancelNotifications() { for (int id : new int[]{7301, 7302, 7303, 7304}) manager().cancel(TAG, id); }
    private void clearLocal() {
        authorization = "";
        api.cancel();
        if (state != null) cancelAlarm(state.grant.generation);
        state = null;
        store.clear();
        WorkManager.getInstance(app).cancelUniqueWork(WORK);
        WorkManager.getInstance(app).cancelUniqueWork(SYNC);
        cancelNotifications();
        lastError = "";
    }
    private boolean persist() {
        if (state == null) return false;
        try { store.write(state); return true; }
        catch (Exception failure) { clearLocal(); lastError = "local_storage"; return false; }
    }
    private boolean current(String generation) {
        return state != null && state.grant.generation.equals(generation) && app.site != null && state.grant.origin.equals(app.site.origin);
    }
    private String installation() {
        android.content.SharedPreferences preferences = app.getSharedPreferences("notification-installation-v1", Context.MODE_PRIVATE);
        String value = preferences.getString("uuid", "");
        try { if (UUID.fromString(value).toString().equals(value)) return value; }
        catch (IllegalArgumentException ignored) { /* Create only once, never derive from hardware identifiers. */ }
        value = UUID.randomUUID().toString();
        if (!preferences.edit().putString("uuid", value).commit()) throw new IllegalStateException("local_storage");
        return value;
    }
    private int boot() { return Settings.Global.getInt(app.getContentResolver(), Settings.Global.BOOT_COUNT, -1); }
    private NotificationManager manager() { return app.getSystemService(NotificationManager.class); }
    private void channels() {
        NotificationChannel inbox = new NotificationChannel(INBOX_CHANNEL, app.getString(R.string.notifications_inbox_channel), NotificationManager.IMPORTANCE_DEFAULT);
        inbox.setShowBadge(true);
        NotificationChannel reminders = new NotificationChannel(REMINDER_CHANNEL, app.getString(R.string.notifications_task_channel), NotificationManager.IMPORTANCE_DEFAULT);
        reminders.setShowBadge(false);
        manager().createNotificationChannel(inbox);
        manager().createNotificationChannel(reminders);
    }
    private static Uri identityURI(String generation, String action) {
        return new Uri.Builder().scheme("astering-notification").authority(action).appendPath(generation).build();
    }
    private static String errorCode(Exception error) {
        if (error instanceof NotificationApi.Failure) return ((NotificationApi.Failure) error).code;
        if (error instanceof IllegalArgumentException || error instanceof java.time.DateTimeException
            || error instanceof org.json.JSONException) return "protocol";
        return "network";
    }
}
