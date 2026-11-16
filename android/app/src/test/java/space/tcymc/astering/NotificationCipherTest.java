package space.tcymc.astering;

import static org.junit.Assert.*;

import java.nio.charset.StandardCharsets;
import java.security.GeneralSecurityException;
import java.util.Arrays;
import javax.crypto.KeyGenerator;
import javax.crypto.SecretKey;
import org.junit.Test;

public final class NotificationCipherTest {
    private static SecretKey key() throws Exception {
        KeyGenerator generator = KeyGenerator.getInstance("AES");
        generator.init(256);
        return generator.generateKey();
    }

    @Test public void privateGrantRoundTripsWithIndependentRandomNonces() throws Exception {
        SecretKey key = key();
        byte[] clear = "Private notification grant; public-fixture-token; 用户的通知状态".getBytes(StandardCharsets.UTF_8);
        byte[] first = NotificationCipher.encrypt(key, clear);
        byte[] second = NotificationCipher.encrypt(key, clear);
        assertFalse(Arrays.equals(first, second));
        assertArrayEquals(clear, NotificationCipher.decrypt(key, first));
        assertArrayEquals(clear, NotificationCipher.decrypt(key, second));
        assertFalse(new String(first, StandardCharsets.UTF_8).contains("public-fixture-token"));
    }

    @Test public void changedCiphertextNonceAndKeyCannotExposePrivateGrant() throws Exception {
        SecretKey key = key();
        byte[] encrypted = NotificationCipher.encrypt(key, new byte[]{1, 2, 3, 4});
        assertThrows(GeneralSecurityException.class, () -> NotificationCipher.decrypt(key(), encrypted));
        byte[] changedNonce = encrypted.clone();
        changedNonce[2] ^= 1;
        assertThrows(GeneralSecurityException.class, () -> NotificationCipher.decrypt(key, changedNonce));
        byte[] changedPayload = encrypted.clone();
        changedPayload[changedPayload.length - 1] ^= 1;
        assertThrows(GeneralSecurityException.class, () -> NotificationCipher.decrypt(key, changedPayload));
        byte[] truncated = Arrays.copyOf(encrypted, encrypted.length - 1);
        assertThrows(GeneralSecurityException.class, () -> NotificationCipher.decrypt(key, truncated));
    }

    @Test public void transcriptCiphertextCannotBeReinterpretedAsNotificationGrant() throws Exception {
        SecretKey key = key();
        String id = "cc9e8357-d681-4d72-9063-992feae42de2";
        byte[] transcript = OutboxCipher.encrypt(key, 7, id, new byte[]{1, 2, 3});
        assertThrows(GeneralSecurityException.class, () -> NotificationCipher.decrypt(key, transcript));
        byte[] grant = NotificationCipher.encrypt(key, new byte[]{1, 2, 3});
        assertThrows(GeneralSecurityException.class, () -> OutboxCipher.decrypt(key, 7, id, grant));
    }

    @Test public void malformedVersionAndOversizedEnvelopesAreRejectedBeforeUse() throws Exception {
        SecretKey key = key();
        byte[] boundary = NotificationCipher.encrypt(key, new byte[NotificationCipher.MAX_BYTES]);
        assertEquals(NotificationCipher.MAX_BYTES, NotificationCipher.decrypt(key, boundary).length);
        assertThrows(GeneralSecurityException.class,
            () -> NotificationCipher.encrypt(key, new byte[NotificationCipher.MAX_BYTES + 1]));
        assertThrows(GeneralSecurityException.class,
            () -> NotificationCipher.decrypt(key, new byte[NotificationCipher.MAX_BYTES + 31]));
        assertThrows(GeneralSecurityException.class, () -> NotificationCipher.decrypt(key, new byte[29]));
        byte[] changedVersion = boundary.clone();
        changedVersion[0] = 2;
        assertThrows(GeneralSecurityException.class, () -> NotificationCipher.decrypt(key, changedVersion));
        byte[] changedNonceLength = boundary.clone();
        changedNonceLength[1] = 11;
        assertThrows(GeneralSecurityException.class, () -> NotificationCipher.decrypt(key, changedNonceLength));
    }
}
