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

/** App-private text; server origin and account bind directory, key alias and authenticated ciphertext. */
final class TranscriptOutbox {
    static final long MAX_BYTES = 8 * 1024 * 1024;
    static final int MAX_ITEMS = 2000;
    private static final int MAX_ITEM_BYTES = 65536;
    private final File root;
    TranscriptOutbox(Context context) { root = new File(context.getNoBackupFilesDir(), "transcript-outbox"); }
    private File directory(String origin, long user) {
        if (user <= 0) throw new IllegalArgumentException("authentication");
        SitePolicy site = SitePolicy.parseServer(origin);
        if (site == null || !site.origin.equals(origin)) throw new IllegalArgumentException("server_required");
        return new File(new File(root, "server-" + site.scope), "user-" + user);
    }
    private File legacyDirectory(long user) {
        if (user <= 0) throw new IllegalArgumentException("authentication");
        return new File(root, "user-" + user);
    }
    synchronized JSONObject status(String origin, long user) { return stats(files(directory(origin, user))); }
    synchronized JSONObject legacyStatus(String origin, long user) {
        if (!SitePolicy.LEGACY_OUTBOX_ORIGIN.equals(origin)) return stats(new File[0]);
        return stats(files(legacyDirectory(user)));
    }
    private JSONObject stats(File[] files) {
        long bytes = 0;
        for (File file : files) bytes += file.length();
        return AsteringApplication.object("pending_count", files.length, "pending_bytes", bytes,
            "max_pending_count", MAX_ITEMS, "max_pending_bytes", MAX_BYTES);
    }
    synchronized void add(String origin, long user, JSONObject payload) throws Exception {
        String id = UUID.fromString(payload.getString("client_id")).toString();
        File directory = directory(origin, user);
        File file = new File(directory, id + ".bin");
        if (file.isFile()) {
            if (!read(origin, user, file).toString().equals(payload.toString())) throw new java.io.IOException("local_storage");
            return;
        }
        byte[] clear = payload.toString().getBytes(StandardCharsets.UTF_8);
        try {
            if (clear.length > MAX_ITEM_BYTES) throw new IllegalStateException("local_storage_full");
            JSONObject stats = status(origin, user);
            if (stats.getInt("pending_count") >= MAX_ITEMS || stats.getLong("pending_bytes") + clear.length + 128 > MAX_BYTES)
                throw new IllegalStateException("local_storage_full");
            if (!directory.isDirectory() && !directory.mkdirs()) throw new java.io.IOException("local_storage");
            byte[] encrypted = OutboxCipher.encrypt(key(origin, user), origin, user, id, clear);
            AtomicFile target = new AtomicFile(file);
            FileOutputStream out = null;
            try {
                out = target.startWrite();
                out.write(encrypted);
                target.finishWrite(out);
            } catch (Exception error) {
                if (out != null) target.failWrite(out);
                throw error;
            }
        } finally { Arrays.fill(clear, (byte) 0); }
    }
    synchronized List<File> pending(String origin, long user) {
        return new ArrayList<>(Arrays.asList(files(directory(origin, user))));
    }
    synchronized JSONObject read(String origin, long user, File file) throws Exception {
        if (!file.getParentFile().equals(directory(origin, user))) throw new java.io.IOException("local_storage");
        String id = clientID(file);
        byte[] clear = OutboxCipher.decrypt(key(origin, user), origin, user, id, envelope(file));
        return decoded(id, clear);
    }
    private static String clientID(File file) throws Exception {
        if (!file.getName().matches("[a-f0-9-]{36}\\.bin")) throw new java.io.IOException("local_storage");
        return UUID.fromString(file.getName().substring(0, 36)).toString();
    }
    private static byte[] envelope(File file) throws Exception {
        if (file.length() > MAX_ITEM_BYTES + 128) throw new java.io.IOException("local_storage");
        try (FileInputStream in = new AtomicFile(file).openRead()) {
            java.io.ByteArrayOutputStream buffer = new java.io.ByteArrayOutputStream();
            byte[] block = new byte[4096];
            int count;
            while ((count = in.read(block)) != -1) {
                if (buffer.size() + count > MAX_ITEM_BYTES + 128) throw new java.io.IOException("local_storage");
                buffer.write(block, 0, count);
            }
            return buffer.toByteArray();
        }
    }
    private static JSONObject decoded(String id, byte[] clear) throws Exception {
        try {
            JSONObject payload = new JSONObject(new String(clear, StandardCharsets.UTF_8));
            if (!id.equals(payload.getString("client_id"))) throw new java.io.IOException("local_storage");
            return payload;
        } finally { Arrays.fill(clear, (byte) 0); }
    }
    synchronized void migrateLegacy(String origin, long user, java.util.function.BooleanSupplier current) throws Exception {
        if (!SitePolicy.LEGACY_OUTBOX_ORIGIN.equals(origin)) throw new IllegalArgumentException("server_required");
        for (File file : files(legacyDirectory(user))) {
            if (!current.getAsBoolean()) throw new IllegalStateException("session_changed");
            String id = clientID(file);
            JSONObject payload = decoded(id, OutboxCipher.decrypt(existingKey("astering-transcript-" + user),
                user, id, envelope(file)));
            add(origin, user, payload);
            // A new scoped AtomicFile has finished writing; interrupted migrations keep the old copy for safe retry.
            if (!current.getAsBoolean()) throw new IllegalStateException("session_changed");
            new AtomicFile(file).delete();
        }
    }
    synchronized void remove(String origin, long user, File file) {
        if (file.getParentFile().equals(directory(origin, user))) new AtomicFile(file).delete();
    }
    synchronized void clear(String origin, long user) {
        File directory = directory(origin, user);
        File[] all = directory.listFiles();
        if (all != null) for (File file : all) if (file.isFile()) new AtomicFile(file).delete();
        directory.delete();
    }
    private static File[] files(File directory) {
        File[] files = directory.listFiles((dir, name) -> name.matches("[a-f0-9-]{36}\\.bin"));
        if (files == null) return new File[0];
        Arrays.sort(files, java.util.Comparator.comparingLong(File::lastModified).thenComparing(File::getName));
        return files;
    }
    private static SecretKey key(String origin, long user) throws Exception {
        return keyAlias("astering-transcript-v2-" + SitePolicy.scopeID(origin) + "-" + user);
    }
    private static SecretKey existingKey(String alias) throws Exception {
        KeyStore store = KeyStore.getInstance("AndroidKeyStore");
        store.load(null);
        if (!store.containsAlias(alias)) throw new java.security.GeneralSecurityException("local_storage");
        return (SecretKey) store.getKey(alias, null);
    }
    private static SecretKey keyAlias(String alias) throws Exception {
        KeyStore store = KeyStore.getInstance("AndroidKeyStore"); store.load(null);
        if (store.containsAlias(alias)) return (SecretKey) store.getKey(alias, null);
        KeyGenerator generator = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore");
        generator.init(new KeyGenParameterSpec.Builder(alias, KeyProperties.PURPOSE_ENCRYPT | KeyProperties.PURPOSE_DECRYPT)
            .setBlockModes(KeyProperties.BLOCK_MODE_GCM).setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
            .setRandomizedEncryptionRequired(true).build());
        return generator.generateKey();
    }
}
