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
import javax.crypto.KeyGenerator;
import javax.crypto.SecretKey;

/** A single active device account. Excluded from backups, encrypted and bounded before parsing. */
final class NotificationStore {
    private static final String ALIAS = "astering-device-notifications-v1";
    private final AtomicFile file;
    private final android.content.SharedPreferences revocation;
    NotificationStore(Context context) {
        file = new AtomicFile(new File(context.getNoBackupFilesDir(), "device-notifications-v1.bin"));
        revocation = context.getSharedPreferences("notification-generation-v1", Context.MODE_PRIVATE);
    }
    NotificationState read() {
        if (!file.getBaseFile().exists()) return null;
        try (FileInputStream input = file.openRead()) {
            if (file.getBaseFile().length() > NotificationCipher.MAX_BYTES + 30) throw new java.io.IOException("local_storage");
            java.io.ByteArrayOutputStream bytes = new java.io.ByteArrayOutputStream();
            byte[] buffer = new byte[8192];
            int count;
            while ((count = input.read(buffer)) != -1) {
                if (bytes.size() + count > NotificationCipher.MAX_BYTES + 30) throw new java.io.IOException("local_storage");
                bytes.write(buffer, 0, count);
            }
            byte[] envelope = bytes.toByteArray();
            byte[] clear = NotificationCipher.decrypt(key(false), envelope);
            NotificationState state = NotificationState.restore(new org.json.JSONObject(new String(clear, StandardCharsets.UTF_8)));
            return state.grant.generation.equals(revocation.getString("active", "")) ? state : null;
        } catch (Exception unavailable) { file.delete(); return null; }
    }
    void write(NotificationState state) throws Exception {
        if (!state.grant.generation.equals(revocation.getString("active", ""))) throw new java.io.IOException("local_storage");
        byte[] clear = state.json().toString().getBytes(StandardCharsets.UTF_8);
        byte[] envelope = NotificationCipher.encrypt(key(true), clear);
        FileOutputStream output = null;
        try {
            output = file.startWrite();
            output.write(envelope);
            file.finishWrite(output);
        } catch (Exception error) {
            if (output != null) file.failWrite(output);
            throw error;
        }
    }
    void activate(NotificationState state) throws Exception {
        if (!revocation.edit().putString("active", state.grant.generation).commit()) throw new java.io.IOException("local_storage");
        write(state);
    }
    @android.annotation.SuppressLint("ApplySharedPref") // Revocation must reach disk before logout returns.
    void clear() {
        // A tombstone and key erasure prevent a failed file deletion from reviving the old credential on restart.
        revocation.edit().putString("active", java.util.UUID.randomUUID().toString()).commit();
        file.delete();
        try { KeyStore store = KeyStore.getInstance("AndroidKeyStore"); store.load(null); store.deleteEntry(ALIAS); }
        catch (Exception ignored) { /* The independent persisted generation remains a second revocation boundary. */ }
    }
    private SecretKey key(boolean create) throws Exception {
        KeyStore store = KeyStore.getInstance("AndroidKeyStore");
        store.load(null);
        if (store.containsAlias(ALIAS)) return (SecretKey) store.getKey(ALIAS, null);
        if (!create) throw new java.security.GeneralSecurityException("local_storage");
        KeyGenerator generator = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore");
        generator.init(new KeyGenParameterSpec.Builder(ALIAS, KeyProperties.PURPOSE_ENCRYPT | KeyProperties.PURPOSE_DECRYPT)
            .setBlockModes(KeyProperties.BLOCK_MODE_GCM).setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
            .setRandomizedEncryptionRequired(true).build());
        return generator.generateKey();
    }
}
