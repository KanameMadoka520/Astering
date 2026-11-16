package space.tcymc.astering;

import android.app.AlertDialog;
import android.app.NotificationManager;
import android.content.Intent;
import android.net.Uri;
import android.os.Build;
import android.os.Handler;
import android.os.Looper;
import android.provider.Settings;
import android.widget.Button;
import android.widget.CheckBox;
import android.widget.LinearLayout;
import android.widget.ScrollView;
import android.widget.TextView;
import org.json.JSONObject;

/** Native-only opt-in; a website may open client settings but cannot switch this device authorization on. */
final class NotificationsDialog {
    private final MainActivity activity;
    private final AsteringApplication app;
    private final AlertDialog dialog;
    private final TextView status;
    private final CheckBox enabled;
    private final CheckBox preview;
    private final CheckBox reminders;
    private final CheckBox dates;
    private final android.widget.Spinner lead;
    private static final int[] LEADS = {0, 5, 15, 30, 60};
    private final CheckBox exact;
    private final Button renew;
    private final Button sync;
    private final Button test;
    private final Handler main = new Handler(Looper.getMainLooper());
    private boolean updating;
    private final Runnable refresh = new Runnable() {
        @Override public void run() {
            if (!dialog.isShowing() || activity.isDestroyed()) return;
            update(); main.postDelayed(this, 1000);
        }
    };

    NotificationsDialog(MainActivity activity) {
        this.activity = activity;
        app = (AsteringApplication) activity.getApplication();
        LinearLayout body = new LinearLayout(activity);
        body.setOrientation(LinearLayout.VERTICAL);
        int padding = dp(20);
        body.setPadding(padding, dp(8), padding, dp(16));
        TextView explanation = new TextView(activity);
        explanation.setText(R.string.notifications_help);
        body.addView(explanation);
        status = new TextView(activity);
        status.setTextIsSelectable(true);
        status.setPadding(0, dp(14), 0, dp(8));
        body.addView(status);
        enabled = check(body, R.string.notifications_enable);
        preview = check(body, R.string.notifications_preview);
        reminders = check(body, R.string.notifications_task_option);
        reminders.setChecked(true);
        dates = check(body, R.string.notifications_date_option);
        dates.setChecked(true);
        TextView leadLabel = new TextView(activity);
        leadLabel.setText(R.string.notifications_date_lead);
        body.addView(leadLabel);
        lead = new android.widget.Spinner(activity);
        lead.setContentDescription(activity.getString(R.string.notifications_date_lead));
        lead.setAdapter(new android.widget.ArrayAdapter<>(activity, android.R.layout.simple_spinner_dropdown_item,
            activity.getResources().getStringArray(R.array.notification_leads)));
        lead.setSelection(2);
        body.addView(lead);
        exact = check(body, R.string.notifications_exact);
        TextView privacy = new TextView(activity);
        privacy.setText(R.string.notifications_privacy);
        privacy.setPadding(0, dp(8), 0, dp(12));
        body.addView(privacy);
        renew = button(body, R.string.notifications_renew);
        sync = button(body, R.string.notifications_sync);
        test = button(body, R.string.notifications_test);
        Button permissions = button(body, R.string.notifications_system);
        Button precision = button(body, R.string.notifications_exact_settings);
        precision.setVisibility(Build.VERSION.SDK_INT >= 31 ? android.view.View.VISIBLE : android.view.View.GONE);
        ScrollView scroll = new ScrollView(activity);
        scroll.addView(body);
        dialog = new AlertDialog.Builder(activity).setTitle(R.string.notifications_title).setView(scroll)
            .setPositiveButton(R.string.client_settings_close, null).create();
        dialog.setOnDismissListener(ignored -> main.removeCallbacks(refresh));
        enabled.setOnCheckedChangeListener((view, checked) -> {
            if (updating) return;
            if (checked) authorize();
            else { app.notifications.disable(true); update(); }
        });
        preview.setOnCheckedChangeListener((view, checked) -> apply());
        reminders.setOnCheckedChangeListener((view, checked) -> apply());
        dates.setOnCheckedChangeListener((view, checked) -> apply());
        lead.setOnItemSelectedListener(new android.widget.AdapterView.OnItemSelectedListener() {
            @Override public void onItemSelected(android.widget.AdapterView<?> parent, android.view.View view, int position, long itemID) { apply(); }
            @Override public void onNothingSelected(android.widget.AdapterView<?> parent) { }
        });
        exact.setOnCheckedChangeListener((view, checked) -> apply());
        renew.setOnClickListener(view -> authorize());
        sync.setOnClickListener(view -> { app.notifications.requestSync(true); update(); });
        test.setOnClickListener(view -> app.notifications.test());
        permissions.setOnClickListener(view -> open(new Intent(Settings.ACTION_APP_NOTIFICATION_SETTINGS)
            .putExtra(Settings.EXTRA_APP_PACKAGE, activity.getPackageName())));
        precision.setOnClickListener(view -> {
            if (Build.VERSION.SDK_INT >= 31) open(new Intent(Settings.ACTION_REQUEST_SCHEDULE_EXACT_ALARM,
                Uri.parse("package:" + activity.getPackageName())));
        });
    }

    void show() { if (!activity.isDestroyed()) { dialog.show(); refresh.run(); } }
    void dismiss() { main.removeCallbacks(refresh); dialog.dismiss(); }

    private void authorize() {
        SessionFence.Ticket owner = app.session.ticket();
        if (owner == null || !app.session.verified(owner)) {
            android.widget.Toast.makeText(activity, R.string.notifications_login_required, android.widget.Toast.LENGTH_LONG).show();
            update(); return;
        }
        boolean allowPreview = preview.isChecked();
        activity.requestDeviceNotificationPermission(() -> {
            if (app.session.verified(owner) && activity.isVisible()) app.notifications.enable(owner, allowPreview);
            update();
        });
        update();
    }

    private void apply() {
        if (updating) return;
        app.notifications.preferences(preview.isChecked(), reminders.isChecked(), dates.isChecked(), LEADS[lead.getSelectedItemPosition()], exact.isChecked());
        update();
    }

    private void update() {
        JSONObject value = app.notifications.status();
        boolean active = value.optBoolean("enabled");
        boolean busy = value.optBoolean("busy");
        updating = true;
        enabled.setChecked(active || value.optBoolean("authorizing"));
        enabled.setEnabled(true); // The user may always stop locally, including while an authorization request is pending.
        if (active) {
            preview.setChecked(value.optBoolean("preview"));
            reminders.setChecked(value.optBoolean("task_reminders"));
            dates.setChecked(value.optBoolean("date_reminders"));
            int selected = 2;
            for (int i = 0; i < LEADS.length; i++) if (LEADS[i] == value.optInt("date_lead", 15)) selected = i;
            if (lead.getSelectedItemPosition() != selected) lead.setSelection(selected);
            exact.setChecked(value.optBoolean("exact"));
        }
        preview.setEnabled(!busy);
        reminders.setEnabled(active && !busy);
        dates.setEnabled(active && !busy);
        lead.setEnabled(active && !busy && dates.isChecked());
        exact.setEnabled(active && !busy);
        sync.setEnabled(active && !busy);
        test.setEnabled(active && !busy);
        SessionFence.Ticket owner = app.session.ticket();
        renew.setEnabled(active && !busy && owner != null && app.session.verified(owner) && owner.owner.userID == value.optLong("user_id"));
        updating = false;
        String message = activity.getString(busy ? R.string.notifications_working : active ? R.string.notifications_enabled : R.string.notifications_disabled);
        NotificationManager manager = activity.getSystemService(NotificationManager.class);
        if (!manager.areNotificationsEnabled()) message += "\n" + activity.getString(R.string.notifications_permission_denied);
        if (active) {
            long last = value.optLong("last_sync");
            message += "\n" + activity.getString(R.string.notifications_sync_status,
                last == 0 ? activity.getString(R.string.notifications_not_yet) : java.text.DateFormat.getDateTimeInstance().format(new java.util.Date(last)),
                value.optLong("reminders"), value.optLong("unread"));
            message += "\n" + activity.getString(R.string.notifications_expires,
                java.text.DateFormat.getDateInstance().format(new java.util.Date(value.optLong("expires_at"))));
            message += "\n" + activity.getString(R.string.notifications_counts, value.optLong("overdue"),
                value.optLong("due_in_window"), value.optLong("upcoming"));
            message += "\n" + activity.getString(value.optBoolean("exact") && value.optBoolean("exact_allowed")
                ? R.string.notifications_precision_exact : R.string.notifications_precision_approx);
        }
        String error = value.optString("error");
        if (!error.isEmpty()) message += "\n" + activity.getString(errorResource(error));
        status.setText(message);
    }

    private int errorResource(String error) {
        switch (error) {
            case "authentication": case "expired": return R.string.notifications_error_auth;
            case "network": return R.string.notifications_error_network;
            case "rate_limited": return R.string.notifications_error_limited;
            case "partial": return R.string.notifications_error_partial;
            case "local_storage": return R.string.notifications_error_storage;
            case "unsupported": return R.string.notifications_error_unsupported;
            case "notification_permission": return R.string.notifications_permission_denied;
            default: return R.string.notifications_error_server;
        }
    }
    private void open(Intent intent) {
        try { activity.startActivity(intent); }
        catch (android.content.ActivityNotFoundException unavailable) {
            android.widget.Toast.makeText(activity, R.string.notifications_settings_unavailable, android.widget.Toast.LENGTH_LONG).show();
        }
    }
    private CheckBox check(LinearLayout parent, int text) {
        CheckBox result = new CheckBox(activity); result.setText(text); result.setMinHeight(dp(48)); parent.addView(result); return result;
    }
    private Button button(LinearLayout parent, int text) {
        Button result = new Button(activity); result.setText(text); parent.addView(result, new LinearLayout.LayoutParams(-1, -2)); return result;
    }
    private int dp(int value) { return Math.round(value * activity.getResources().getDisplayMetrics().density); }
}
