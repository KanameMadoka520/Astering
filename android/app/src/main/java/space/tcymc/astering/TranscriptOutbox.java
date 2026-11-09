package space.tcymc.astering;

import android.content.Context;
import android.security.keystore.KeyGenParameterSpec;
import android.security.keystore.KeyProperties;
import android.util.AtomicFile;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.nio.charset.StandardCharsets;
import java.security.KeyStore;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.List;
import java.util.UUID;
import javax.crypto.KeyGenerator;
import javax.crypto.SecretKey;
import org.json.JSONObject;

/** App-private, account-scoped encrypted text only. Audio is never written to disk. */
final class TranscriptOutbox {
    static final long MAX_BYTES = 8 * 1024 * 1024;
    static final int MAX_ITEMS = 2000;
    private static final int MAX_ITEM_BYTES = 65536;
    private final File root;
    TranscriptOutbox(Context context) { root = new File(context.getNoBackupFilesDir(), "transcript-outbox"); }
    private File directory(long user) {
        if (user <= 0) throw new IllegalArgumentException("authentication");
        return new File(root, "user-" + user);
    }
    synchronized JSONObject status(long user) {
        File[] files = files(user);
        long bytes = 0;
        for (File file : files) bytes += file.length();
        return AsteringApplication.object("pending_count", files.length, "pending_bytes", bytes,
            "max_pending_count", MAX_ITEMS, "max_pending_bytes", MAX_BYTES);
    }
    synchronized void add(long user, JSONObject payload) throws Exception {
        String id = UUID.fromString(payload.getString("client_id")).toString();
        byte[] clear = payload.toString().getBytes(StandardCharsets.UTF_8);
        if (clear.length > MAX_ITEM_BYTES) throw new IllegalStateException("local_storage_full");
        JSONObject stats = status(user);
        if (stats.getInt("pending_count") >= MAX_ITEMS || stats.getLong("pending_bytes") + clear.length + 128 > MAX_BYTES)
            throw new IllegalStateException("local_storage_full");
        File directory = directory(user);
        if (!directory.isDirectory() && !directory.mkdirs()) throw new java.io.IOException("local_storage");
        byte[] encrypted = OutboxCipher.encrypt(key(user), user, id, clear);
        AtomicFile target = new AtomicFile(new File(directory, id + ".bin"));
        FileOutputStream out = null;
        try {
            out = target.startWrite();
            out.write(encrypted);
            target.finishWrite(out);
        } catch (Exception error) {
            if (out != null) target.failWrite(out);
            throw error;
        } finally { Arrays.fill(clear, (byte) 0); }
    }
    synchronized List<File> pending(long user) { return new ArrayList<>(Arrays.asList(files(user))); }
    synchronized JSONObject read(long user, File file) throws Exception {
        if (!file.getParentFile().equals(directory(user)) || file.length() > MAX_ITEM_BYTES + 128)
            throw new java.io.IOException("local_storage");
        String id = file.getName().substring(0, file.getName().length() - 4);
        UUID.fromString(id);
        try (FileInputStream in = new AtomicFile(file).openRead()) {
            java.io.ByteArrayOutputStream buffer = new java.io.ByteArrayOutputStream();
            byte[] block = new byte[4096];
            int count;
            while ((count = in.read(block)) != -1) {
                if (buffer.size() + count > MAX_ITEM_BYTES + 128) throw new java.io.IOException("local_storage");
                buffer.write(block, 0, count);
            }
            byte[] bytes = buffer.toByteArray();
            byte[] clear = OutboxCipher.decrypt(key(user), user, id, bytes);
            try {
                JSONObject payload = new JSONObject(new String(clear, StandardCharsets.UTF_8));
                if (!id.equals(payload.getString("client_id"))) throw new java.io.IOException("local_storage");
                return payload;
            } finally { Arrays.fill(clear, (byte) 0); }
        }
    }
    synchronized void remove(long user, File file) {
        if (file.getParentFile().equals(directory(user))) new AtomicFile(file).delete();
    }
    synchronized void clear(long user) {
        File directory = directory(user);
        File[] all = directory.listFiles();
        if (all != null) for (File file : all) if (file.isFile()) new AtomicFile(file).delete();
        directory.delete();
    }
    private File[] files(long user) {
        File[] files = directory(user).listFiles((dir, name) -> name.matches("[a-f0-9-]{36}\\.bin"));
        if (files == null) return new File[0];
        Arrays.sort(files, java.util.Comparator.comparingLong(File::lastModified).thenComparing(File::getName));
        return files;
    }
    private static SecretKey key(long user) throws Exception {
        String alias = "astering-transcript-" + user;
        KeyStore store = KeyStore.getInstance("AndroidKeyStore"); store.load(null);
        if (store.containsAlias(alias)) return (SecretKey) store.getKey(alias, null);
        KeyGenerator generator = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore");
        generator.init(new KeyGenParameterSpec.Builder(alias, KeyProperties.PURPOSE_ENCRYPT | KeyProperties.PURPOSE_DECRYPT)
            .setBlockModes(KeyProperties.BLOCK_MODE_GCM).setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
            .setRandomizedEncryptionRequired(true).build());
        return generator.generateKey();
    }
}
