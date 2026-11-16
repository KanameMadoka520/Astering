package space.tcymc.astering;

import static org.junit.Assert.*;

import java.time.Instant;
import org.json.JSONArray;
import org.json.JSONObject;
import org.junit.Test;

public final class NotificationStateTest {
    private static final long NOW = Instant.parse("2026-11-16T06:00:00Z").toEpochMilli();
    private static final long ELAPSED = 10_000;
    private static final int BOOT = 12;
    private static final long DAY = 24 * 3600_000L;
    private static final String GENERATION = "cc9e8357-d681-4d72-9063-992feae42de2";

    private static JSONObject object(Object... pairs) throws Exception {
        JSONObject value = new JSONObject();
        for (int i = 0; i < pairs.length; i += 2) value.put((String) pairs[i], pairs[i + 1]);
        return value;
    }

    private static String at(long time) { return Instant.ofEpochMilli(time).toString(); }

    private static NotificationState state(boolean preview) {
        return new NotificationState(new NotificationGrant("https://one.example", 7, 3,
            "public_fixture_notification_token", NOW + 30 * DAY, GENERATION), preview);
    }

    private static JSONObject reminder(String key, long when) throws Exception {
        return object("key", key, "task_id", 42, "trigger_at", at(when), "title", "Private teacher meeting");
    }

    private static NotificationSnapshot snapshot(long generated, long expires, boolean complete,
        long watermark, long unread, long[] notificationIDs, boolean preview, JSONObject... reminders) throws Exception {
        JSONArray alarmValues = new JSONArray();
        for (JSONObject reminder : reminders) alarmValues.put(reminder);
        JSONArray notifications = new JSONArray();
        for (long id : notificationIDs) notifications.put(object("id", id, "name", "ai.automation"));
        return NotificationSnapshot.parse(object("schema_version", 1, "user_id", 7,
            "generated_at", at(generated), "valid_until", at(expires), "horizon_end", at(generated + 7 * DAY),
            "timezone", "UTC",
            "counts", object("unread_notifications", unread, "personal_open", 2, "overdue", 1, "due_in_window", 1, "upcoming", 1),
            "newest_notification_id", watermark, "reminders_complete", complete, "notifications_complete", true,
            "reminders", alarmValues, "notifications", notifications), 7, preview);
    }

    private static NotificationSnapshot inboxSnapshot(long generated, long watermark, JSONObject... notifications) throws Exception {
        JSONArray values = new JSONArray();
        for (JSONObject notification : notifications) values.put(notification);
        return NotificationSnapshot.parse(object("schema_version", 1, "user_id", 7,
            "generated_at", at(generated), "valid_until", at(NOW + 3600_000), "horizon_end", at(generated + 7 * DAY),
            "timezone", "UTC",
            "counts", object("unread_notifications", notifications.length, "personal_open", 0, "overdue", 0, "due_in_window", 0, "upcoming", 0),
            "newest_notification_id", watermark, "reminders_complete", true, "notifications_complete", true,
            "reminders", new JSONArray(), "notifications", values), 7, false);
    }

    @Test public void emptyFirstInboxStillEstablishesBaselineAndNextUnreadNotifiesOnce() throws Exception {
        NotificationState state = state(false);
        assertFalse(state.apply(snapshot(NOW, NOW + 3600_000, true, 0, 0, new long[0], false),
            NOW, ELAPSED, BOOT));
        assertTrue(state.baseline);
        NotificationSnapshot next = snapshot(NOW + 1000, NOW + 3600_000, true, 1, 1, new long[]{1}, false);
        assertTrue(state.apply(next, NOW + 1000, ELAPSED + 1000, BOOT));
        assertFalse(state.apply(next, NOW + 2000, ELAPSED + 2000, BOOT));
        assertEquals(1, state.watermark);
        NotificationState restored = NotificationState.restore(new JSONObject(state.json().toString()));
        assertFalse(restored.apply(next, NOW + 3000, ELAPSED + 3000, BOOT));
        assertEquals(GENERATION, restored.grant.generation);
        assertEquals("https://one.example", restored.grant.origin);
        assertEquals(7, restored.grant.userID);
    }

    @Test public void firstExistingUnreadListDoesNotBackfillOldSoundsAndCountsCanDecrease() throws Exception {
        NotificationState state = state(false);
        assertFalse(state.apply(snapshot(NOW, NOW + 3600_000, true, 50, 2, new long[]{50, 49}, false),
            NOW, ELAPSED, BOOT));
        assertFalse(state.apply(snapshot(NOW + 1000, NOW + 3600_000, true, 50, 0, new long[0], false),
            NOW + 1000, ELAPSED + 1000, BOOT));
        assertEquals(0, state.unread);
        assertEquals(50, state.watermark);
    }

    @Test public void matchingPersistedReminderUpdatesBadgeWithoutDuplicatingDeliveredLocalAlarm() throws Exception {
        NotificationState state = state(false);
        state.apply(snapshot(NOW, NOW + 3600_000, true, 0, 0, new long[0], false,
            reminder("reminder:42:5", NOW + 1000)), NOW, ELAPSED, BOOT);
        assertEquals(1, state.takeDue(ELAPSED + 1000, BOOT).size());
        JSONObject matching = object("id", 1, "name", "task.reminder", "reminder_key", "reminder:42:5",
            "reminder_trigger_at", at(NOW + 1000));
        assertFalse(state.apply(inboxSnapshot(NOW + 2000, 1, matching), NOW + 2000, ELAPSED + 2000, BOOT));
        assertEquals(1, state.unread);
        assertTrue(state.apply(inboxSnapshot(NOW + 3000, 2,
            matching, object("id", 2, "name", "ai.automation")), NOW + 3000, ELAPSED + 3000, BOOT));
        assertEquals(2, state.watermark);
    }

    @Test public void reminderWithoutMatchingLocalDeliveryKeepsGenericNewMessageAlert() throws Exception {
        NotificationState state = state(false);
        state.apply(inboxSnapshot(NOW, 0), NOW, ELAPSED, BOOT);
        assertTrue(state.apply(inboxSnapshot(NOW + 1000, 1, object("id", 1, "name", "task.reminder")),
            NOW + 1000, ELAPSED + 1000, BOOT));
        assertTrue(state.apply(inboxSnapshot(NOW + 2000, 2,
            object("id", 2, "name", "task.reminder", "reminder_key", "new-period",
                "reminder_trigger_at", at(NOW + 2000))), NOW + 2000, ELAPSED + 2000, BOOT));
        assertEquals(1, state.unread);
        assertEquals(2, state.watermark);
    }

    @Test public void applyingInboxMetadataIsBoundedBeforeTheFirstDurableSave() throws Exception {
        NotificationState state = state(false);
        state.apply(inboxSnapshot(NOW, 0), NOW, ELAPSED, BOOT);
        for (int i = 0; i < 2048; i++) state.delivered.put("old:" + i + "@" + NOW, NOW);
        JSONObject incoming = object("id", 1, "name", "task.reminder", "reminder_key", "reminder:77",
            "reminder_trigger_at", at(NOW + 1000));
        assertTrue(state.apply(inboxSnapshot(NOW + 1000, 1, incoming), NOW + 1000, ELAPSED + 1000, BOOT));
        // The coordinator saves immediately after apply, before takeDue may trim anything.
        NotificationState restored = NotificationState.restore(new JSONObject(state.json().toString()));
        assertEquals(2048, restored.delivered.size());
        assertTrue(restored.delivered.containsKey("reminder:77@" + (NOW + 1000)));
        assertEquals(1, restored.watermark);
    }

    @Test public void deliveredReminderPersistsAcrossRestartAndChangedTriggerIsNewEvent() throws Exception {
        NotificationState state = state(false);
        state.apply(snapshot(NOW, NOW + 3600_000, true, 0, 0, new long[0], false,
            reminder("reminder:42:5", NOW + 30_000)), NOW, ELAPSED, BOOT);
        assertEquals(ELAPSED + 30_000, state.nextAlarm(ELAPSED, BOOT));
        assertTrue(state.takeDue(ELAPSED + 29_999, BOOT).isEmpty());
        assertEquals(1, state.takeDue(ELAPSED + 30_000, BOOT).size());
        assertTrue(state.takeDue(ELAPSED + 30_001, BOOT).isEmpty());
        state = NotificationState.restore(new JSONObject(state.json().toString()));
        assertTrue(state.takeDue(ELAPSED + 30_002, BOOT).isEmpty());
        state.apply(snapshot(NOW + 31_000, NOW + 3600_000, true, 0, 0, new long[0], false,
            reminder("reminder:42:5", NOW + 60_000)), NOW + 31_000, ELAPSED + 31_000, BOOT);
        assertEquals(1, state.takeDue(ELAPSED + 60_000, BOOT).size());
    }

    @Test public void partialSnapshotPreservesAbsentAlarmWithoutExtendingItsAuthority() throws Exception {
        NotificationState state = state(false);
        state.apply(snapshot(NOW, NOW + 90_000, true, 0, 0, new long[0], false,
            reminder("retained", NOW + 80_000)), NOW, ELAPSED, BOOT);
        state.apply(snapshot(NOW + 10_000, NOW + 200_000, false, 0, 0, new long[0], false),
            NOW + 10_000, ELAPSED + 10_000, BOOT);
        assertTrue(state.reminders.containsKey("retained"));
        assertEquals(NOW + 90_000, state.reminders.get("retained").validUntil);
        assertTrue(state.valid(ELAPSED + 100_000, BOOT));
        assertTrue(state.takeDue(ELAPSED + 100_000, BOOT).isEmpty());
    }

    @Test public void completeSnapshotMayRemoveAnAlarmAndOptOutPreventsDelivery() throws Exception {
        NotificationState state = state(false);
        state.apply(snapshot(NOW, NOW + 90_000, true, 0, 0, new long[0], false,
            reminder("removed", NOW + 30_000)), NOW, ELAPSED, BOOT);
        state.taskReminders = false;
        assertTrue(state.takeDue(ELAPSED + 30_000, BOOT).isEmpty());
        state.apply(snapshot(NOW + 31_000, NOW + 90_000, true, 0, 0, new long[0], false),
            NOW + 31_000, ELAPSED + 31_000, BOOT);
        assertTrue(state.reminders.isEmpty());
    }

    @Test public void derivedDatesUseSelectedLeadIndependentlyOfExplicitReminderPreference() throws Exception {
        NotificationState state = state(false);
        JSONObject derived = reminder("start:42", NOW + 1800_000).put("source", "start");
        state.apply(snapshot(NOW, NOW + 3600_000, true, 0, 0, new long[0], false,
            derived, reminder("explicit:42", NOW + 1800_000)), NOW, ELAPSED, BOOT);
        state.taskReminders = false;
        assertEquals(ELAPSED + 900_000, state.nextAlarm(ELAPSED, BOOT));
        assertEquals(1, state.takeDue(ELAPSED + 900_000, BOOT).size());
        state.dateLeadMinutes = 0;
        assertTrue("changing lead must not replay an already delivered event", state.takeDue(ELAPSED + 1800_000, BOOT).isEmpty());
        state.taskReminders = true;
        state.dateReminders = false;
        assertEquals(1, state.takeDue(ELAPSED + 1800_000, BOOT).size());
        NotificationState restored = NotificationState.restore(new JSONObject(state.json().toString()));
        assertTrue(restored.taskReminders);
        assertFalse(restored.dateReminders);
        assertEquals(0, restored.dateLeadMinutes);
    }

    @Test public void rebootOrMonotonicClockResetInvalidatesCachedPrivateAlerts() throws Exception {
        NotificationState state = state(false);
        state.apply(snapshot(NOW, NOW + 3600_000, true, 0, 0, new long[0], false,
            reminder("not-after-reboot", NOW + 30_000)), NOW, ELAPSED, BOOT);
        assertFalse(state.clockTrusted(ELAPSED - 1, BOOT));
        assertFalse(state.valid(ELAPSED + 30_000, BOOT + 1));
        assertTrue(state.takeDue(ELAPSED + 30_000, BOOT + 1).isEmpty());
        assertEquals(0, state.nextAlarm(ELAPSED + 30_000, BOOT + 1));
        NotificationState restored = NotificationState.restore(new JSONObject(state.json().toString()));
        assertFalse(restored.valid(ELAPSED + 30_000, BOOT + 1));
        assertEquals(NOW + 30_000, state.serverNow(ELAPSED + 30_000, BOOT));
    }

    @Test public void unknownBootCounterCannotProveThatCachedAuthorizationIsStillFresh() throws Exception {
        NotificationState state = state(false);
        state.apply(snapshot(NOW, NOW + 3600_000, true, 0, 0, new long[0], false,
            reminder("unknown-boot", NOW + 30_000)), NOW, ELAPSED, -1);
        NotificationState restored = NotificationState.restore(new JSONObject(state.json().toString()));
        assertFalse(restored.clockTrusted(ELAPSED + 30_000, -1));
        assertFalse(restored.valid(ELAPSED + 30_000, -1));
        assertTrue(restored.takeDue(ELAPSED + 30_000, -1).isEmpty());
        assertEquals(0, restored.nextAlarm(ELAPSED + 30_000, -1));
    }

    @Test public void repeatedSnapshotCannotTurnBackMonotonicServerClockOrExtendExpiry() throws Exception {
        NotificationState state = state(false);
        NotificationSnapshot original = snapshot(NOW, NOW + 3600_000, true, 0, 0, new long[0], false);
        state.apply(original, NOW, ELAPSED, BOOT);
        state.apply(original, NOW - DAY, ELAPSED + 1800_000, BOOT);
        assertEquals(NOW + 1800_000, state.serverNow(ELAPSED + 1800_000, BOOT));
        assertFalse(state.valid(ELAPSED + 3600_000, BOOT));
    }

    @Test public void outOfOrderSnapshotIsRejectedBeforeRemovingCurrentAlarms() throws Exception {
        NotificationState state = state(false);
        state.apply(snapshot(NOW + 1000, NOW + 3600_000, true, 8, 1, new long[]{8}, false,
            reminder("current", NOW + 30_000)), NOW + 1000, ELAPSED + 1000, BOOT);
        NotificationSnapshot old = snapshot(NOW, NOW + 3600_000, true, 0, 0, new long[0], false);
        assertThrows(IllegalArgumentException.class, () -> state.apply(old, NOW + 2000, ELAPSED + 2000, BOOT));
        assertTrue(state.reminders.containsKey("current"));
        assertEquals(8, state.watermark);
        assertEquals(1, state.unread);
    }

    @Test public void partialCapacityDoesNotUseMissingEntriesToCancelKnownAlarms() throws Exception {
        NotificationState state = state(false);
        JSONObject[] originals = new JSONObject[NotificationSnapshot.MAX_REMINDERS];
        for (int i = 0; i < originals.length; i++) originals[i] = reminder("known:" + i, NOW + 30_000);
        state.apply(snapshot(NOW, NOW + 3600_000, true, 0, 0, new long[0], false, originals), NOW, ELAPSED, BOOT);
        state.apply(snapshot(NOW + 1000, NOW + 3600_000, false, 0, 0, new long[0], false,
            reminder("partial-new", NOW + 60_000)), NOW + 1000, ELAPSED + 1000, BOOT);
        assertEquals(NotificationSnapshot.MAX_REMINDERS, state.reminders.size());
        for (int i = 0; i < originals.length; i++) assertTrue(state.reminders.containsKey("known:" + i));
    }

    @Test public void privateTitlesAreNotRetainedWithoutPreviewAndCanBeRemovedImmediately() throws Exception {
        NotificationSnapshot hidden = snapshot(NOW, NOW + 3600_000, true, 0, 0, new long[0], false,
            reminder("private", NOW + 30_000));
        assertEquals("", hidden.reminders.get(0).title);
        NotificationState state = state(true);
        state.apply(snapshot(NOW, NOW + 3600_000, true, 0, 0, new long[0], true,
            reminder("private", NOW + 30_000)), NOW, ELAPSED, BOOT);
        assertEquals("Private teacher meeting", state.reminders.get("private").reminder.title);
        state.hidePreviews();
        assertFalse(state.preview);
        assertFalse(state.json().toString().contains("Private teacher meeting"));
        NotificationState restored = NotificationState.restore(new JSONObject(state.json().toString()));
        assertEquals("", restored.reminders.get("private").reminder.title);
    }
}
