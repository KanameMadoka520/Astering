package space.tcymc.astering;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;

/** Local alarms never perform network I/O, open a WebView or start the microphone service. */
public final class TaskReminderReceiver extends BroadcastReceiver {
    @Override public void onReceive(Context context, Intent intent) {
        if (intent == null) return;
        AsteringApplication app = (AsteringApplication) context.getApplicationContext();
        if (DeviceNotifications.TICK.equals(intent.getAction())) app.notifications.tick(intent);
        else if (Intent.ACTION_BOOT_COMPLETED.equals(intent.getAction()) || Intent.ACTION_TIME_CHANGED.equals(intent.getAction())
            || Intent.ACTION_TIMEZONE_CHANGED.equals(intent.getAction()) || Intent.ACTION_MY_PACKAGE_REPLACED.equals(intent.getAction())
            || "android.app.action.SCHEDULE_EXACT_ALARM_PERMISSION_STATE_CHANGED".equals(intent.getAction()))
            app.notifications.reschedule();
    }
}
