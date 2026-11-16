package space.tcymc.astering;

import android.content.Context;
import androidx.work.Worker;
import androidx.work.WorkerParameters;

/** WorkManager persists only scheduling metadata; no credential is placed in its input database. */
public final class NotificationSyncWorker extends Worker {
    public NotificationSyncWorker(Context context, WorkerParameters parameters) { super(context, parameters); }
    @Override public Result doWork() {
        AsteringApplication app = (AsteringApplication) getApplicationContext();
        return app.notifications == null || !app.notifications.sync() ? Result.retry() : Result.success();
    }
}
