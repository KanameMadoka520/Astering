package space.tcymc.astering;

import java.nio.charset.StandardCharsets;
import java.security.GeneralSecurityException;
import java.util.UUID;
import javax.crypto.Cipher;
import javax.crypto.SecretKey;
import javax.crypto.spec.GCMParameterSpec;

/** Versioned AES-GCM envelope binds ciphertext to both its account and immutable client UUID. */
final class OutboxCipher {
    static final int MAX_CLEAR_BYTES = 65536;
    static byte[] encrypt(SecretKey key, long user, String clientID, byte[] clear) throws GeneralSecurityException {
        if (clear.length > MAX_CLEAR_BYTES) throw new GeneralSecurityException("local_storage_full");
        Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
        cipher.init(Cipher.ENCRYPT_MODE, key);
        cipher.updateAAD(aad(user, clientID));
        byte[] encrypted = cipher.doFinal(clear);
        byte[] out = new byte[14 + encrypted.length];
        out[0] = 1; out[1] = 12;
        System.arraycopy(cipher.getIV(), 0, out, 2, 12);
        System.arraycopy(encrypted, 0, out, 14, encrypted.length);
        return out;
    }
    static byte[] decrypt(SecretKey key, long user, String clientID, byte[] envelope) throws GeneralSecurityException {
        if (envelope.length < 30 || envelope.length > MAX_CLEAR_BYTES + 30 || envelope[0] != 1 || envelope[1] != 12)
            throw new GeneralSecurityException("local_storage");
        Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
        cipher.init(Cipher.DECRYPT_MODE, key, new GCMParameterSpec(128, envelope, 2, 12));
        cipher.updateAAD(aad(user, clientID));
        return cipher.doFinal(envelope, 14, envelope.length - 14);
    }
    private static byte[] aad(long user, String clientID) {
        if (user <= 0 || !UUID.fromString(clientID).toString().equals(clientID))
            throw new IllegalArgumentException("authentication");
        return ("Astering/transcript/v1/" + user + "/" + clientID).getBytes(StandardCharsets.UTF_8);
    }
}
