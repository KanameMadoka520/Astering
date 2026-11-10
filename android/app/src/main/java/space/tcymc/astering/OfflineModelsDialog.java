package space.tcymc.astering;

import android.app.AlertDialog;
import android.content.ActivityNotFoundException;
import android.content.Intent;
import android.graphics.Color;
import android.graphics.Typeface;
import android.graphics.drawable.GradientDrawable;
import android.net.ConnectivityManager;
import android.net.Uri;
import android.os.Handler;
import android.os.Looper;
import android.view.View;
import android.view.Window;
import android.view.WindowManager;
import android.widget.Button;
import android.widget.LinearLayout;
import android.widget.ProgressBar;
import android.widget.ScrollView;
import android.widget.TextView;
import android.widget.Toast;
import java.util.ArrayList;
import java.util.List;
import org.json.JSONArray;
import org.json.JSONObject;

/** Device-wide public model files are managed without rebuilding the current website. */
final class OfflineModelsDialog {
    private final MainActivity activity;
    private final OfflineModels models;
    private final Handler main = new Handler(Looper.getMainLooper());
    private final List<Row> rows = new ArrayList<>();
    private final AlertDialog dialog;
    private AlertDialog prompt;
    private final TextView summary;
    private final Runnable refresh = new Runnable() {
        @Override public void run() {
            if (!dialog.isShowing() || activity.isDestroyed()) return;
            update();
            main.postDelayed(this, 1000);
        }
    };

    OfflineModelsDialog(MainActivity activity, OfflineModels models) {
        this.activity = activity;
        this.models = models;
        ScrollView scroll = new ScrollView(activity);
        scroll.setFillViewport(false);
        LinearLayout content = column();
        content.setPadding(dp(20), dp(8), dp(20), dp(12));
        TextView intro = text(14, Color.rgb(71, 85, 105));
        intro.setText(R.string.models_help);
        content.addView(intro, layout());
        summary = text(13, Color.rgb(71, 85, 105));
        summary.setPadding(0, dp(12), 0, dp(4));
        content.addView(summary, layout());
        for (OfflineModelCatalog.Model spec : OfflineModelCatalog.all()) {
            Row row = new Row(spec);
            rows.add(row);
            LinearLayout.LayoutParams params = layout();
            params.topMargin = dp(12);
            content.addView(row.card, params);
        }
        TextView footer = text(13, Color.rgb(71, 85, 105));
        footer.setText(R.string.models_privacy);
        footer.setPadding(0, dp(16), 0, dp(4));
        content.addView(footer, layout());
        scroll.addView(content);
        dialog = new AlertDialog.Builder(activity)
            .setTitle(R.string.models_title)
            .setView(scroll)
            .setPositiveButton(R.string.client_settings_close, null)
            .create();
        dialog.setOnDismissListener(ignored -> {
            main.removeCallbacks(refresh);
            dismissPrompt();
        });
    }

    void show() {
        if (activity.isDestroyed() || activity.isFinishing()) return;
        if (!dialog.isShowing()) dialog.show();
        Window window = dialog.getWindow();
        if (window != null) {
            int width = Math.min(activity.getResources().getDisplayMetrics().widthPixels - dp(24), dp(600));
            window.setLayout(width, WindowManager.LayoutParams.WRAP_CONTENT);
        }
        main.removeCallbacks(refresh);
        refresh.run();
    }

    void dismiss() {
        main.removeCallbacks(refresh);
        dismissPrompt();
        if (dialog.isShowing()) dialog.dismiss();
    }

    private void update() {
        JSONObject snapshot = models.snapshot();
        JSONArray entries = snapshot.optJSONArray("models");
        long bytes = 0;
        String selected = activity.getString(R.string.models_none);
        for (Row row : rows) {
            JSONObject item = new JSONObject();
            if (entries != null) for (int i = 0; i < entries.length(); i++) {
                JSONObject candidate = entries.optJSONObject(i);
                if (candidate != null && candidate.optString("id").equals(row.spec.id)) {
                    item = candidate;
                    break;
                }
            }
            bytes += item.optLong("disk_bytes");
            if (item.optBoolean("selected")) selected = row.spec.name;
            row.update(snapshot, item);
        }
        summary.setText(snapshot.optString("phase").equals("checking")
            ? activity.getString(R.string.models_checking)
            : activity.getString(R.string.models_summary, selected, mib(bytes)));
    }

    private final class Row {
        final OfflineModelCatalog.Model spec;
        final LinearLayout card = column();
        final TextView badge = text(12, Color.rgb(3, 105, 161));
        final TextView size = text(13, Color.rgb(71, 85, 105));
        final TextView state = text(13, Color.rgb(71, 85, 105));
        final ProgressBar progress = new ProgressBar(activity, null, android.R.attr.progressBarStyleHorizontal);
        final Button primary = button();
        final Button remove = button();
        boolean installed;
        boolean active;
        boolean transferBusy;

        Row(OfflineModelCatalog.Model spec) {
            this.spec = spec;
            card.setPadding(dp(14), dp(14), dp(14), dp(10));
            GradientDrawable background = new GradientDrawable();
            background.setColor(Color.WHITE);
            background.setCornerRadius(dp(14));
            background.setStroke(dp(1), Color.rgb(203, 213, 225));
            card.setBackground(background);
            TextView title = text(17, Color.rgb(15, 23, 42));
            title.setTypeface(null, Typeface.BOLD);
            title.setText(spec.engine.equals("qwen3_asr")
                ? spec.name + " · " + activity.getString(R.string.models_experimental) : spec.name);
            card.addView(title, layout());
            badge.setPadding(0, dp(4), 0, dp(4));
            card.addView(badge, layout());
            TextView description = text(14, Color.rgb(51, 65, 85));
            boolean chinese = activity.getResources().getConfiguration().getLocales().get(0).getLanguage().equals("zh");
            description.setText(chinese ? spec.descriptionZh : spec.descriptionEn);
            description.setPadding(0, dp(4), 0, dp(8));
            card.addView(description, layout());
            card.addView(size, layout());
            progress.setMax(10000);
            LinearLayout.LayoutParams progressParams = layout();
            progressParams.topMargin = dp(8);
            card.addView(progress, progressParams);
            state.setPadding(0, dp(4), 0, dp(4));
            state.setAccessibilityLiveRegion(View.ACCESSIBILITY_LIVE_REGION_NONE);
            card.addView(state, layout());
            primary.setOnClickListener(ignored -> {
                if (active && transferBusy) {
                    models.pause();
                } else if (installed) {
                    report(models.select(spec.id));
                } else {
                    download(spec);
                }
                OfflineModelsDialog.this.update();
            });
            card.addView(primary, layout());
            remove.setText(R.string.models_remove);
            remove.setOnClickListener(ignored -> confirmRemove(spec));
            card.addView(remove, layout());
            Button source = button();
            source.setText(activity.getString(R.string.models_source, spec.license));
            source.setOnClickListener(ignored -> showSource(spec));
            card.addView(source, layout());
        }

        void update(JSONObject snapshot, JSONObject entry) {
            installed = entry.optBoolean("installed");
            boolean selected = entry.optBoolean("selected");
            boolean inUse = entry.optBoolean("in_use");
            String phase = snapshot.optString("phase", "idle");
            active = snapshot.optString("active_id").equals(spec.id);
            transferBusy = phase.equals("downloading") || phase.equals("verifying");
            boolean busy = transferBusy || phase.equals("verifying") || phase.equals("deleting") || phase.equals("checking");
            badge.setText(inUse ? R.string.models_in_use : selected ? R.string.models_selected
                : installed ? R.string.models_installed : R.string.models_not_installed);
            size.setText(activity.getString(R.string.models_size, mib(spec.bytes()), mib(entry.optLong("disk_bytes"))));
            long received = active ? snapshot.optLong("received_bytes") : entry.optLong("downloaded_bytes");
            long total = active ? snapshot.optLong("total_bytes", spec.bytes()) : spec.bytes();
            progress.setVisibility(!installed && received > 0 || active && busy ? View.VISIBLE : View.GONE);
            progress.setIndeterminate(active && (phase.equals("verifying") || phase.equals("deleting") || total <= 0));
            if (total > 0) progress.setProgress((int) Math.min(10000, Math.max(0, received * 10000.0 / total)));
            String error = active ? snapshot.optString("error") : "";
            if (!error.isEmpty()) {
                state.setText(errorText(error));
                state.setTextColor(Color.rgb(180, 35, 24));
            } else {
                state.setTextColor(Color.rgb(71, 85, 105));
                if (active && phase.equals("downloading")) {
                    state.setText(activity.getString(R.string.models_progress,
                        total > 0 ? Math.min(100, received * 100.0 / total) : 0,
                        mib(received), mib(total), snapshot.optDouble("bytes_per_second") / 1024));
                } else if (active && phase.equals("verifying")) {
                    state.setText(R.string.models_verifying);
                } else if (active && phase.equals("deleting")) {
                    state.setText(R.string.models_deleting);
                } else if (active && phase.equals("checking")) {
                    state.setText(R.string.models_checking);
                } else if (!installed && received > 0) {
                    state.setText(activity.getString(R.string.models_paused, mib(received)));
                } else {
                    state.setText(installed ? R.string.models_verified : R.string.models_download_needed);
                }
            }
            primary.setText(active && transferBusy ? R.string.models_pause : selected ? R.string.models_selected
                : installed ? R.string.models_use : received > 0 ? R.string.models_resume : R.string.models_download);
            primary.setContentDescription(primary.getText() + " · " + spec.name);
            primary.setEnabled(active && transferBusy || !busy && !selected && !inUse);
            remove.setVisibility(installed || entry.optLong("disk_bytes") > 0 ? View.VISIBLE : View.GONE);
            remove.setContentDescription(activity.getString(R.string.models_remove) + " · " + spec.name);
            remove.setEnabled(!busy && !inUse);
        }
    }

    private void download(OfflineModelCatalog.Model spec) {
        ConnectivityManager connectivity = activity.getSystemService(ConnectivityManager.class);
        if (connectivity == null || connectivity.isActiveNetworkMetered()) {
            dismissPrompt();
            prompt = new AlertDialog.Builder(activity)
                .setTitle(R.string.models_metered_title)
                .setMessage(activity.getString(R.string.models_metered_message, spec.name, mib(spec.bytes())))
                .setNegativeButton(R.string.cancel, null)
                .setPositiveButton(R.string.models_download, (ignored, which) -> { models.download(spec.id); update(); })
                .show();
        } else {
            models.download(spec.id);
        }
    }

    private void confirmRemove(OfflineModelCatalog.Model spec) {
        dismissPrompt();
        prompt = new AlertDialog.Builder(activity)
            .setTitle(R.string.models_remove_title)
            .setMessage(activity.getString(R.string.models_remove_message, spec.name))
            .setNegativeButton(R.string.cancel, null)
            .setPositiveButton(R.string.models_remove, (ignored, which) -> { report(models.remove(spec.id)); update(); })
            .show();
    }

    private void showSource(OfflineModelCatalog.Model spec) {
        dismissPrompt();
        prompt = new AlertDialog.Builder(activity)
            .setTitle(R.string.models_source_title)
            .setMessage(activity.getString(R.string.models_source_message, spec.license, spec.source))
            .setNegativeButton(R.string.client_settings_close, null)
            .setPositiveButton(R.string.models_open_source, (ignored, which) -> {
                try {
                    activity.startActivity(new Intent(Intent.ACTION_VIEW, Uri.parse(spec.source))
                        .addCategory(Intent.CATEGORY_BROWSABLE));
                } catch (ActivityNotFoundException unavailable) {
                    Toast.makeText(activity, R.string.models_no_browser, Toast.LENGTH_LONG).show();
                }
            }).show();
    }

    private void dismissPrompt() {
        if (prompt != null) { prompt.dismiss(); prompt = null; }
    }

    private void report(String code) {
        if (code != null) Toast.makeText(activity, errorText(code), Toast.LENGTH_LONG).show();
    }

    private String errorText(String code) {
        int resource;
        switch (code) {
            case "already_recording": resource = R.string.models_error_recording; break;
            case "model_not_ready": resource = R.string.models_error_not_ready; break;
            case "busy": resource = R.string.models_error_busy; break;
            case "insufficient_space": case "storage_full": resource = R.string.models_error_space; break;
            case "checksum": case "checksum_mismatch": case "hash_mismatch": case "integrity":
                resource = R.string.models_error_hash; break;
            case "storage": case "model_storage": case "local_storage": resource = R.string.models_error_storage; break;
            default: resource = R.string.models_error_download;
        }
        return activity.getString(resource);
    }

    private LinearLayout column() {
        LinearLayout result = new LinearLayout(activity);
        result.setOrientation(LinearLayout.VERTICAL);
        return result;
    }

    private Button button() {
        Button result = new Button(activity);
        result.setAllCaps(false);
        result.setMinHeight(dp(48));
        result.setTextSize(14);
        return result;
    }

    private TextView text(int size, int color) {
        TextView result = new TextView(activity);
        result.setTextSize(size);
        result.setTextColor(color);
        result.setLineSpacing(dp(2), 1);
        return result;
    }

    private LinearLayout.LayoutParams layout() {
        return new LinearLayout.LayoutParams(-1, -2);
    }

    private int dp(int value) {
        return Math.round(value * activity.getResources().getDisplayMetrics().density);
    }

    private static double mib(long bytes) {
        return bytes / 1024.0 / 1024;
    }
}
