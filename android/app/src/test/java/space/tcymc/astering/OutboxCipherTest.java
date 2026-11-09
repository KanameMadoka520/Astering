package space.tcymc.astering;

import static org.junit.Assert.*;
import java.nio.charset.StandardCharsets;
import java.security.GeneralSecurityException;
import java.util.Arrays;
import javax.crypto.KeyGenerator;
import javax.crypto.SecretKey;
import org.junit.Test;

public final class OutboxCipherTest {
    private static final String ID = "cc9e8357-d681-4d72-9063-992feae42de2";
    private static final String OTHER_ID = "152d6483-649c-4a6a-b570-598329cc953d";
    private static SecretKey key() throws Exception {
        KeyGenerator generator = KeyGenerator.getInstance("AES"); generator.init(256); return generator.generateKey();
    }
    @Test public void transcriptRoundTripsWithFreshIvAndNeverContainsPlainText() throws Exception {
        SecretKey key = key();
        byte[] clear = "只保存文字，录音不落盘。A long private transcript.".getBytes(StandardCharsets.UTF_8);
        byte[] a = OutboxCipher.encrypt(key, 7, ID, clear);
        byte[] b = OutboxCipher.encrypt(key, 7, ID, clear);
        assertFalse(Arrays.equals(a, b));
        assertArrayEquals(clear, OutboxCipher.decrypt(key, 7, ID, a));
        assertFalse(new String(a, StandardCharsets.UTF_8).contains("private transcript"));
    }
    @Test public void movingCiphertextToAnotherUserOrUuidFailsAuthentication() throws Exception {
        SecretKey key = key();
        byte[] envelope = OutboxCipher.encrypt(key, 7, ID, new byte[]{1, 2, 3});
        assertThrows(GeneralSecurityException.class, () -> OutboxCipher.decrypt(key, 8, ID, envelope));
        assertThrows(GeneralSecurityException.class, () -> OutboxCipher.decrypt(key, 7, OTHER_ID, envelope));
        assertThrows(GeneralSecurityException.class, () -> OutboxCipher.decrypt(key(), 7, ID, envelope));
        envelope[envelope.length - 1] ^= 1;
        assertThrows(GeneralSecurityException.class, () -> OutboxCipher.decrypt(key, 7, ID, envelope));
    }
    @Test public void envelopesAreVersionedAndBoundedBeforeDecryption() throws Exception {
        SecretKey key = key();
        assertThrows(GeneralSecurityException.class, () -> OutboxCipher.encrypt(key, 7, ID, new byte[65537]));
        assertThrows(GeneralSecurityException.class, () -> OutboxCipher.decrypt(key, 7, ID, new byte[65567]));
        byte[] envelope = OutboxCipher.encrypt(key, 7, ID, new byte[65536]);
        assertEquals(65536, OutboxCipher.decrypt(key, 7, ID, envelope).length);
        envelope[0] = 2;
        assertThrows(GeneralSecurityException.class, () -> OutboxCipher.decrypt(key, 7, ID, envelope));
    }
}
