package space.tcymc.astering;

import android.app.Activity;
import android.app.AlertDialog;
import android.content.ActivityNotFoundException;
import android.content.ClipData;
import android.content.Intent;
import android.content.pm.PackageInfo;
import android.content.pm.PackageManager;
import android.content.pm.Signature;
import android.net.Uri;
import android.os.Build;
import android.os.Handler;
import android.os.Looper;
import android.provider.Settings;
import android.widget.LinearLayout;
import android.widget.ProgressBar;
import android.widget.TextView;
import androidx.core.content.FileProvider;
import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.security.MessageDigest;
import java.util.Locale;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.TimeUnit;
import okhttp3.Call;
import okhttp3.OkHttpClient;
import okhttp3.Request;
import okhttp3.Response;
import org.json.JSONArray;

/** No server cookies, JWTs or website settings enter this independent public GitHub client. */
final class AndroidUpdater {
    private static final long CHECK_INTERVAL_MS = 12 * 60 * 60 * 1000L;
    private static final int MAX_METADATA_BYTES = 2 * 1024 * 1024;
    private final Activity activity;
    private final Handler main = new Handler(Looper.getMainLooper());
    private final ExecutorService worker = Executors.newSingleThreadExecutor();
    private final OkHttpClient http = new OkHttpClient.Builder()
        .connectTimeout(20, TimeUnit.SECONDS).readTimeout(45, TimeUnit.SECONDS)
        .callTimeout(30, TimeUnit.MINUTES).followRedirects(false).followSslRedirects(false).build();
    private volatile boolean closed;
    private volatile boolean cancelled;
    private volatile Call activeCall;
    private boolean busy;
    private boolean showCheckResult;
    private AlertDialog dialog;
    private File readyFile;
    private AndroidUpdatePolicy.Update readyUpdate;

    AndroidUpdater(Activity activity) {
        this.activity = activity;
        // Only our own update cache is disposable; never touch notes or pending transcripts.
        worker.execute(() -> {
            File dir = directory();
            File[] files = dir.listFiles();
            if (files != null) for (File file : files) {
                java.util.regex.Matcher name = java.util.regex.Pattern.compile(
                    "astering-v[0-9.]+-aster\\.([1-9][0-9]{0,8})-android\\.apk(?:\\.[a-f0-9-]{36}\\.part)?")
                    .matcher(file.getName());
                if (name.matches() && (Integer.parseInt(name.group(1)) <= BuildConfig.VERSION_CODE
                    || file.lastModified() < System.currentTimeMillis() - 7L * 24 * 60 * 60 * 1000)) {
                    file.delete();
                }
            }
        });
    }

    void check(boolean explicit) {
        if (closed || activity.isFinishing()) return;
        if (busy) {
            if (explicit && dialog == null) {
                showCheckResult = true;
                checkingDialog();
            }
            return;
        }
        if (readyFile != null && !readyFile.isFile()) {
            readyFile = null;
            readyUpdate = null;
        }
        if (readyFile != null && readyUpdate != null) {
            if (explicit) offerInstall();
            return;
        }
        long now = System.currentTimeMillis();
        android.content.SharedPreferences preferences = activity.getSharedPreferences("github_updates", 0);
        long last = preferences.getLong("last_success", 0);
        long attempt = preferences.getLong("last_attempt", 0);
        if (!explicit && ((now >= last && now - last < CHECK_INTERVAL_MS)
            || (now >= attempt && now - attempt < 5 * 60 * 1000L))) return;
        preferences.edit().putLong("last_attempt", now).apply();
        busy = true;
        cancelled = false;
        showCheckResult = explicit;
        if (explicit) checkingDialog();
        worker.execute(() -> {
            try {
                AndroidUpdatePolicy.Update best = null;
                for (int page = 1; page <= 3; page++) {
                    JSONArray releases = new JSONArray(metadata(page));
                    AndroidUpdatePolicy.Update candidate = AndroidUpdatePolicy.newest(releases, BuildConfig.VERSION_CODE);
                    if (candidate != null && (best == null || candidate.code() > best.code())) best = candidate;
                    if (releases.length() < 100) break;
                }
                AndroidUpdatePolicy.Update result = best;
                main.post(() -> {
                    if (!usable()) return;
                    busy = false;
                    preferences.edit().putLong("last_success", System.currentTimeMillis()).apply();
                    dismiss();
                    if (result != null) offerDownload(result);
                    else if (showCheckResult) message(R.string.update_current);
                });
            } catch (Exception ignored) {
                main.post(() -> {
                    if (!usable()) return;
                    busy = false;
                    dismiss();
                    if (showCheckResult) message(R.string.update_check_failed);
                });
            }
        });
    }

    private void checkingDialog() {
        dialog = new AlertDialog.Builder(activity).setTitle(R.string.update_check)
            .setMessage(R.string.update_checking).setNegativeButton(R.string.cancel, (d, which) -> cancel())
            .setOnCancelListener(d -> cancel()).show();
    }

    private String metadata(int page) throws IOException {
        Request request = new Request.Builder().url(AndroidUpdatePolicy.RELEASES_API + "?per_page=100&page=" + page)
            .header("Accept", "application/vnd.github+json").header("X-GitHub-Api-Version", "2026-03-10")
            .header("User-Agent", "Astering-Android/" + BuildConfig.VERSION_NAME).build();
        try (Response response = execute(request, 45)) {
            if (!response.isSuccessful() || response.body() == null) throw new IOException("metadata");
            if (response.body().contentLength() > MAX_METADATA_BYTES) throw new IOException("metadata_size");
            try (InputStream input = response.body().byteStream(); ByteArrayOutputStream out = new ByteArrayOutputStream()) {
                byte[] buffer = new byte[16384];
                int n;
                while ((n = input.read(buffer)) != -1) {
                    if (cancelled || closed || out.size() + n > MAX_METADATA_BYTES) throw new IOException("cancelled");
                    out.write(buffer, 0, n);
                }
                return new String(out.toByteArray(), java.nio.charset.StandardCharsets.UTF_8);
            }
        }
    }

    private Response execute(Request request) throws IOException {
        return execute(request, 30 * 60);
    }

    private Response execute(Request request, int timeoutSeconds) throws IOException {
        if (closed || cancelled) throw new IOException("cancelled");
        Call call = http.newCall(request);
        call.timeout().timeout(timeoutSeconds, TimeUnit.SECONDS);
        activeCall = call;
        if (closed || cancelled) call.cancel();
        return call.execute();
    }

    private void offerDownload(AndroidUpdatePolicy.Update update) {
        dialog = new AlertDialog.Builder(activity).setTitle(R.string.update_available)
            .setMessage(activity.getString(R.string.update_offer, BuildConfig.VERSION_NAME,
                update.version(), update.size() / (1024d * 1024d)))
            .setNegativeButton(R.string.update_later, null)
            .setPositiveButton(R.string.update_download, (d, which) -> download(update)).show();
    }

    private void download(AndroidUpdatePolicy.Update update) {
        if (closed || busy) return;
        busy = true;
        cancelled = false;
        LinearLayout content = new LinearLayout(activity);
        content.setOrientation(LinearLayout.VERTICAL);
        int pad = (int) (24 * activity.getResources().getDisplayMetrics().density);
        content.setPadding(pad, pad / 2, pad, pad / 2);
        TextView status = new TextView(activity);
        status.setText(R.string.update_preparing);
        ProgressBar progress = new ProgressBar(activity, null, android.R.attr.progressBarStyleHorizontal);
        progress.setMax(1000);
        content.addView(status);
        content.addView(progress, new LinearLayout.LayoutParams(-1, -2));
        dialog = new AlertDialog.Builder(activity).setTitle(R.string.update_downloading).setView(content)
            .setNegativeButton(R.string.cancel, (d, which) -> cancel())
            .setOnCancelListener(d -> cancel()).show();
        worker.execute(() -> {
            File part = new File(directory(), update.name() + "." + java.util.UUID.randomUUID() + ".part");
            File target = new File(directory(), update.name());
            try {
                File dir = directory();
                if (!dir.isDirectory() && !dir.mkdirs()) throw new IOException("storage");
                if (target.isFile() && reusable(target, update)) {
                    verifyPackage(target, update);
                    downloaded(target, update);
                    return;
                }
                if (dir.getUsableSpace() < update.size() + 32L * 1024 * 1024) throw new IOException("storage");
                MessageDigest digest = MessageDigest.getInstance("SHA-256");
                String url = update.url();
                Response response = null;
                for (int redirects = 0; redirects <= 5; redirects++) {
                    if (!AndroidUpdatePolicy.allowedDownload(url)) throw new IOException("destination");
                    response = execute(new Request.Builder().url(url).header("Accept-Encoding", "identity")
                        .header("User-Agent", "Astering-Android/" + BuildConfig.VERSION_NAME).build());
                    if (!response.isRedirect()) break;
                    String location = response.header("Location");
                    okhttp3.HttpUrl destination = location == null ? null : response.request().url().resolve(location);
                    response.close();
                    response = null;
                    if (destination == null || redirects == 5) throw new IOException("redirect");
                    url = destination.toString();
                }
                if (response == null) throw new IOException("download");
                try (Response bodyResponse = response) {
                    if (bodyResponse.code() != 200 || bodyResponse.body() == null) throw new IOException("download");
                    long announced = bodyResponse.body().contentLength();
                    if (announced != -1 && announced != update.size()) throw new IOException("length");
                    long count = 0;
                    long started = android.os.SystemClock.elapsedRealtime();
                    long last = started;
                    try (InputStream input = bodyResponse.body().byteStream(); FileOutputStream output = new FileOutputStream(part)) {
                        byte[] buffer = new byte[65536];
                        int n;
                        while ((n = input.read(buffer)) != -1) {
                            if (closed || cancelled || count + n > update.size()) throw new IOException("cancelled");
                            output.write(buffer, 0, n);
                            digest.update(buffer, 0, n);
                            count += n;
                            long now = android.os.SystemClock.elapsedRealtime();
                            if (now - last >= 250 || count == update.size()) {
                                last = now;
                                long received = count;
                                double speed = received / (Math.max(1d, (now - started) / 1000d) * 1024d);
                                main.post(() -> {
                                    if (!usable()) return;
                                    progress.setProgress((int) (received * 1000 / update.size()));
                                    status.setText(activity.getString(R.string.update_progress, received * 100d / update.size(),
                                        received / (1024d * 1024d), update.size() / (1024d * 1024d), speed));
                                });
                            }
                        }
                        output.getFD().sync();
                    }
                    if (count != update.size() || !hex(digest.digest()).equals(update.sha256())) throw new IOException("integrity");
                }
                main.post(() -> { if (usable()) status.setText(R.string.update_verifying); });
                verifyPackage(part, update);
                if (closed || cancelled || !part.renameTo(target)) throw new IOException("cancelled");
                downloaded(target, update);
            } catch (Exception ignored) {
                part.delete();
                main.post(() -> {
                    if (closed) return;
                    busy = false;
                    dismiss();
                    if (!cancelled) message(R.string.update_download_failed);
                });
            }
        });
    }

    private boolean reusable(File file, AndroidUpdatePolicy.Update update) throws Exception {
        if (file.length() != update.size()) return false;
        main.post(() -> { if (usable() && dialog != null) dialog.setTitle(R.string.update_verifying); });
        MessageDigest digest = MessageDigest.getInstance("SHA-256");
        try (InputStream input = new java.io.FileInputStream(file)) {
            byte[] buffer = new byte[65536];
            int n;
            while ((n = input.read(buffer)) != -1) {
                if (closed || cancelled) throw new IOException("cancelled");
                digest.update(buffer, 0, n);
            }
        }
        return hex(digest.digest()).equals(update.sha256());
    }

    private void downloaded(File target, AndroidUpdatePolicy.Update update) {
        main.post(() -> {
            if (!usable()) return;
            busy = false;
            readyFile = target;
            readyUpdate = update;
            dismiss();
            offerInstall();
        });
    }

    @SuppressWarnings("deprecation")
    private void verifyPackage(File file, AndroidUpdatePolicy.Update update) throws Exception {
        PackageManager pm = activity.getPackageManager();
        int flags = Build.VERSION.SDK_INT >= 28 ? PackageManager.GET_SIGNING_CERTIFICATES : PackageManager.GET_SIGNATURES;
        PackageInfo incoming = pm.getPackageArchiveInfo(file.getAbsolutePath(), flags);
        PackageInfo installed = pm.getPackageInfo(activity.getPackageName(), flags);
        if (incoming == null || !activity.getPackageName().equals(incoming.packageName)
            || !update.version().equals(incoming.versionName)) throw new IOException("package");
        long incomingCode = Build.VERSION.SDK_INT >= 28 ? incoming.getLongVersionCode() : incoming.versionCode;
        if (incomingCode != update.code() || incomingCode <= BuildConfig.VERSION_CODE) throw new IOException("version");
        Signature[] actual = Build.VERSION.SDK_INT >= 28 && incoming.signingInfo != null
            ? incoming.signingInfo.getApkContentsSigners() : incoming.signatures;
        Signature[] expected = Build.VERSION.SDK_INT >= 28 && installed.signingInfo != null
            ? installed.signingInfo.getApkContentsSigners() : installed.signatures;
        if (actual == null || expected == null || actual.length != 1 || expected.length != 1
            || !MessageDigest.isEqual(actual[0].toByteArray(), expected[0].toByteArray())) throw new IOException("signature");
    }

    private void offerInstall() {
        if (closed || readyFile == null || !readyFile.isFile()) return;
        dialog = new AlertDialog.Builder(activity).setTitle(R.string.update_ready)
            .setMessage(R.string.update_install_message)
            .setNegativeButton(R.string.update_later, null)
            .setPositiveButton(R.string.update_install, (d, which) -> install()).show();
    }

    private void install() {
        if (closed || readyFile == null || readyUpdate == null) return;
        AsteringApplication app = (AsteringApplication) activity.getApplication();
        if (app.recorder != null || app.approvedRecording != null) {
            message(R.string.update_recording_active);
            return;
        }
        try {
            if (!activity.getPackageManager().canRequestPackageInstalls()) {
                dialog = new AlertDialog.Builder(activity).setTitle(R.string.update_install_permission)
                    .setMessage(R.string.update_install_permission_detail)
                    .setNegativeButton(R.string.cancel, null)
                    .setPositiveButton(R.string.update_open_settings, (d, which) -> {
                        try {
                            activity.startActivity(new Intent(Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES,
                                Uri.parse("package:" + activity.getPackageName())));
                        } catch (ActivityNotFoundException ignored) { message(R.string.update_install_failed); }
                    }).show();
                return;
            }
            // The file is private and already verified; only this exact cache directory is shared.
            Uri uri = FileProvider.getUriForFile(activity, activity.getPackageName() + ".updates", readyFile);
            Intent intent = new Intent(Intent.ACTION_VIEW).setDataAndType(uri, "application/vnd.android.package-archive")
                .addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);
            intent.setClipData(ClipData.newRawUri("Astering update", uri));
            activity.startActivity(intent);
        } catch (ActivityNotFoundException | IllegalArgumentException | SecurityException ignored) {
            message(R.string.update_install_failed);
        }
    }

    private File directory() { return new File(activity.getCacheDir(), "updates"); }
    private boolean usable() { return !closed && !cancelled && !activity.isFinishing() && !activity.isDestroyed(); }
    private void message(int text) {
        if (!closed && !activity.isFinishing()) dialog = new AlertDialog.Builder(activity)
            .setTitle(R.string.update_check).setMessage(text).setPositiveButton(android.R.string.ok, null).show();
    }
    private void dismiss() { if (dialog != null) { dialog.dismiss(); dialog = null; } }
    private void cancel() {
        cancelled = true;
        Call call = activeCall;
        if (call != null) call.cancel();
        // Keep busy until the worker exits, so an old cancellation cannot affect a newer download.
        worker.execute(() -> main.post(() -> { if (!closed) busy = false; }));
    }
    void close() {
        closed = true;
        cancelled = true;
        Call call = activeCall;
        if (call != null) call.cancel();
        dismiss();
        worker.shutdownNow();
        http.connectionPool().evictAll();
        http.dispatcher().executorService().shutdown();
    }
    private static String hex(byte[] bytes) {
        StringBuilder result = new StringBuilder(bytes.length * 2);
        for (byte value : bytes) result.append(String.format(Locale.ROOT, "%02x", value & 255));
        return result.toString();
    }
}
