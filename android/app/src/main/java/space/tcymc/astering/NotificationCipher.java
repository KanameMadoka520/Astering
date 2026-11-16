package space.tcymc.astering;

import java.nio.charset.StandardCharsets;
import java.security.GeneralSecurityException;
import javax.crypto.Cipher;
import javax.crypto.SecretKey;
import javax.crypto.spec.GCMParameterSpec;

/** Separate purpose and key from saved speech transcripts; private device grants never enter preferences. */
final class NotificationCipher {
    private static final byte[] AAD = "Astering/device-notifications/v1".getBytes(StandardCharsets.UTF_8);
    static final int MAX_BYTES = 1024 * 1024;
    static byte[] encrypt(SecretKey key, byte[] clear) throws GeneralSecurityException {
        if (clear.length > MAX_BYTES) throw new GeneralSecurityException("response_limit");
        Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
        cipher.init(Cipher.ENCRYPT_MODE, key);
        cipher.updateAAD(AAD);
        byte[] encrypted = cipher.doFinal(clear);
        byte[] result = new byte[14 + encrypted.length];
        result[0] = 1;
        result[1] = 12;
        System.arraycopy(cipher.getIV(), 0, result, 2, 12);
        System.arraycopy(encrypted, 0, result, 14, encrypted.length);
        return result;
    }
    static byte[] decrypt(SecretKey key, byte[] envelope) throws GeneralSecurityException {
        if (envelope.length < 30 || envelope.length > MAX_BYTES + 30 || envelope[0] != 1 || envelope[1] != 12)
            throw new GeneralSecurityException("local_storage");
        Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
        cipher.init(Cipher.DECRYPT_MODE, key, new GCMParameterSpec(128, envelope, 2, 12));
        cipher.updateAAD(AAD);
        return cipher.doFinal(envelope, 14, envelope.length - 14);
    }
}
