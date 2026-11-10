package space.tcymc.astering;

import android.os.Handler;
import android.os.Looper;
import java.io.File;
import java.io.IOException;
import java.io.InterruptedIOException;
import java.nio.file.Files;
import java.util.HashMap;
import java.util.Map;
import java.util.concurrent.Executors;
import java.util.concurrent.atomic.AtomicBoolean;
import okhttp3.OkHttpClient;
import org.json.JSONArray;
import org.json.JSONObject;

/** Public model weights belong to this device, never to a server/account or the transcript outbox. */
final class OfflineModels {
    private static final long SPACE_RESERVE = 64L * 1024 * 1024;
    private final AsteringApplication app;
    private final File root;
    private final android.content.SharedPreferences preferences;
    private final java.util.concurrent.ExecutorService worker = Executors.newSingleThreadExecutor(
        runnable -> new Thread(runnable, "Astering-ModelStore"));
    private final OfflineModelDownload transfer = new OfflineModelDownload(new OkHttpClient());
    private final Handler main = new Handler(Looper.getMainLooper());
    private final Map<String, Entry> entries = new HashMap<>();
    private String selectedID;
    private String phase = "checking", activeID = "", error = "";
    private long received, total, speed, operation;
    private boolean initialized;
    private AtomicBoolean cancellation = new AtomicBoolean();

    private static final class Entry {
        boolean installed;
        long downloaded, disk;
        int leases;
    }

    static final class Lease implements AutoCloseable {
        final OfflineModelCatalog.Model model;
        final File directory;
        private final OfflineModels store;
        private final AtomicBoolean closed = new AtomicBoolean();
        Lease(OfflineModels store, OfflineModelCatalog.Model model, File directory) {
            this.store = store; this.model = model; this.directory = directory;
        }
        String path(String relative) { return new File(directory, relative).getAbsolutePath(); }
        @Override public void close() {
            if (closed.compareAndSet(false, true)) store.release(model.id);
        }
    }

    OfflineModels(AsteringApplication app) {
        this.app = app;
        File privateDirectory = app.getNoBackupFilesDir();
        try { privateDirectory = privateDirectory.getCanonicalFile(); }
        catch (IOException ignored) { /* The transfer's strict path checks still fail closed. */ }
        // /data/user/0 itself may be an Android-owned symlink; only canonicalize this trusted OS prefix.
        root = new File(privateDirectory, "offline-models");
        preferences = app.getSharedPreferences("offline-models", 0);
        selectedID = preferences.getString("selected", "");
        for (OfflineModelCatalog.Model model : OfflineModelCatalog.all()) entries.put(model.id, new Entry());
        worker.execute(this::scan);
    }

    private void scan() {
        // SHA verification runs off the UI thread, once per process, before any model may be opened.
        for (OfflineModelCatalog.Model model : OfflineModelCatalog.all()) {
            boolean valid = true;
            File directory = new File(root, model.id);
            try {
                for (OfflineModelDownload.Asset asset : model.assets) {
                    if (!OfflineModelDownload.verified(asset, new File(directory, asset.name), () -> false)) {
                        valid = false; break;
                    }
                }
            } catch (IOException failure) { valid = false; }
            synchronized (this) {
                Entry entry = entries.get(model.id);
                entry.installed = valid;
                recount(model, entry);
            }
        }
        synchronized (this) {
            if (!entries.containsKey(selectedID) || !entries.get(selectedID).installed) {
                selectedID = "";
                preferences.edit().remove("selected").apply();
            }
            phase = "idle";
            initialized = true;
        }
        changed();
    }

    synchronized boolean hasSelected() {
        return initialized && entries.containsKey(selectedID) && entries.get(selectedID).installed;
    }

    synchronized OfflineModelCatalog.Model selected() {
        return hasSelected() ? OfflineModelCatalog.get(selectedID) : null;
    }

    synchronized Lease acquire() {
        if (!hasSelected()) return null;
        Entry entry = entries.get(selectedID);
        entry.leases++;
        return new Lease(this, OfflineModelCatalog.get(selectedID), new File(root, selectedID));
    }

    private synchronized void release(String id) {
        Entry entry = entries.get(id);
        if (entry == null || entry.leases <= 0) throw new IllegalStateException("model_lease");
        entry.leases--;
    }

    synchronized String select(String id) {
        Entry entry = entries.get(id);
        if (!initialized || entry == null || !entry.installed) return "model_not_ready";
        if (entries.values().stream().anyMatch(e -> e.leases > 0) || app.recorder != null || app.approvedRecording != null)
            return "already_recording";
        if (phase.equals("deleting") && activeID.equals(id)) return "busy";
        if (!preferences.edit().putString("selected", id).commit()) return "local_storage";
        selectedID = id;
        changed();
        return null;
    }

    synchronized JSONObject snapshot() {
        JSONArray models = new JSONArray();
        for (OfflineModelCatalog.Model model : OfflineModelCatalog.all()) {
            Entry entry = entries.get(model.id);
            models.put(AsteringApplication.object("id", model.id, "installed", entry.installed,
                "selected", model.id.equals(selectedID), "downloaded_bytes", entry.downloaded,
                "disk_bytes", entry.disk, "in_use", entry.leases > 0));
        }
        return AsteringApplication.object("models", models, "phase", phase, "active_id", activeID,
            "selected_id", selectedID, "error", error, "received_bytes", received,
            "total_bytes", total, "bytes_per_second", speed);
    }

    synchronized void download(String id) {
        OfflineModelCatalog.Model model = OfflineModelCatalog.get(id);
        if (!initialized || model == null || phase.equals("downloading") || phase.equals("verifying") || phase.equals("deleting")) return;
        Entry entry = entries.get(id);
        if (entry.installed) return;
        phase = "downloading"; activeID = id; error = ""; received = entry.downloaded; total = model.bytes(); speed = 0;
        AtomicBoolean stop = new AtomicBoolean();
        cancellation = stop;
        long job = ++operation;
        worker.execute(() -> fetch(model, job, stop));
    }

    void pause() {
        synchronized (this) {
            if (!phase.equals("downloading") && !phase.equals("verifying")) return;
            cancellation.set(true);
        }
        transfer.cancel();
    }

    private void fetch(OfflineModelCatalog.Model model, long job, AtomicBoolean stop) {
        File directory = new File(root, model.id);
        try {
            if (!directory.isDirectory() && !directory.mkdirs()) throw new IOException("local_storage");
            // A failed hash check must not make an invalid old file count as reusable download progress.
            // This profile is not installed and has no recognizer leases, so only its fixed files may be cleaned.
            for (OfflineModelDownload.Asset asset : model.assets) {
                if (stop.get()) throw new InterruptedIOException("cancelled");
                File file = new File(directory, asset.name);
                File partial = new File(directory, asset.name+".part");
                if (file.exists()) {
                    if (!OfflineModelDownload.verified(asset, file, stop::get)) Files.delete(file.toPath());
                    else Files.deleteIfExists(partial.toPath());
                }
            }
            long existing;
            synchronized (this) { recount(model, entries.get(model.id)); existing = entries.get(model.id).downloaded; }
            if (directory.getUsableSpace() < Math.max(0, model.bytes()-existing) + SPACE_RESERVE)
                throw new IOException("storage_full");
            long began = android.os.SystemClock.elapsedRealtime();
            long[] progressAt = {began};
            long initial = existing;
            for (OfflineModelDownload.Asset asset : model.assets) {
                transfer.fetch(asset, new File(directory, asset.name), stop::get, (count, size) -> {
                    long now = android.os.SystemClock.elapsedRealtime();
                    if (count != size && now-progressAt[0] < 150) return;
                    progressAt[0] = now;
                    synchronized (this) {
                        if (operation != job) return;
                        Entry e = entries.get(model.id);
                        recount(model, e);
                        received = e.downloaded;
                        long elapsed = Math.max(1, now-began);
                        speed = Math.max(0, received-initial) * 1000 / elapsed;
                    }
                });
                if (stop.get()) throw new InterruptedIOException("cancelled");
            }
            synchronized (this) { if (operation == job) { phase = "verifying"; speed = 0; } }
            for (OfflineModelDownload.Asset asset : model.assets) {
                if (!OfflineModelDownload.verified(asset, new File(directory, asset.name), stop::get))
                    throw new IOException("checksum_mismatch");
            }
            synchronized (this) {
                if (operation != job) return;
                if (stop.get()) throw new InterruptedIOException("cancelled");
                Entry entry = entries.get(model.id);
                entry.installed = true;
                recount(model, entry);
                received = total; phase = "idle"; error = "";
            }
            changed();
        } catch (IOException | RuntimeException failure) {
            synchronized (this) {
                if (operation != job) return;
                recount(model, entries.get(model.id));
                received = entries.get(model.id).downloaded;
                phase = stop.get() ? "paused" : "failed";
                String message = failure.getMessage() == null ? "" : failure.getMessage();
                if (stop.get()) error = "";
                else if (message.contains("checksum")) error = "checksum_mismatch";
                else if (message.equals("storage_full") || directory.getUsableSpace() < SPACE_RESERVE) error = "storage_full";
                else if (message.equals("local_storage") || message.equals("storage")) error = "local_storage";
                else if (message.contains("protocol") || message.contains("redirect") || message.contains("size")) error = "protocol";
                else error = "network";
            }
        } finally {
            synchronized (this) { if (operation == job) speed = 0; }
        }
    }

    synchronized String remove(String id) {
        OfflineModelCatalog.Model model = OfflineModelCatalog.get(id);
        if (model == null || !initialized) return "model_not_ready";
        if (entries.get(id).leases > 0 || id.equals(selectedID) && (app.recorder != null || app.approvedRecording != null))
            return "already_recording";
        if (phase.equals("downloading") || phase.equals("verifying") || phase.equals("deleting")) return "busy";
        if (id.equals(selectedID)) {
            if (!preferences.edit().remove("selected").commit()) return "local_storage";
            selectedID = "";
        }
        phase = "deleting"; activeID = id; error = "";
        entries.get(id).installed = false;
        worker.execute(() -> {
            String failure = "";
            try { removeTree(new File(root, model.id)); }
            catch (IOException | RuntimeException ignored) { failure = "local_storage"; }
            synchronized (this) {
                recount(model, entries.get(model.id));
                phase = failure.isEmpty() ? "idle" : "failed"; error = failure; received = 0; total = 0;
            }
            changed();
        });
        changed();
        return null;
    }

    private void recount(OfflineModelCatalog.Model model, Entry entry) {
        long bytes = 0, disk = 0;
        File directory = new File(root, model.id);
        for (OfflineModelDownload.Asset asset : model.assets) {
            File file = new File(directory, asset.name);
            File partial = new File(directory, asset.name+".part");
            bytes += file.isFile() ? Math.min(asset.bytes, file.length()) : partial.isFile() ? Math.min(asset.bytes, partial.length()) : 0;
            disk += file.isFile() ? file.length() : 0;
            disk += partial.isFile() ? partial.length() : 0;
        }
        entry.disk = disk;
        entry.downloaded = bytes;
    }

    private void removeTree(File directory) throws IOException {
        // The catalogue, never a web page or model response, owns directory names.
        if (!directory.getCanonicalFile().getParentFile().equals(root.getCanonicalFile())) throw new IOException("local_storage");
        if (!directory.exists()) return;
        try (java.util.stream.Stream<java.nio.file.Path> paths = Files.walk(directory.toPath())) {
            for (java.nio.file.Path path : paths.sorted(java.util.Comparator.reverseOrder())
                    .collect(java.util.stream.Collectors.toList())) Files.delete(path);
        }
    }

    private void changed() {
        main.post(() -> { if (app.offline != null) app.offline.modelChanged(); });
    }
}
