package space.tcymc.astering;

import static org.junit.Assert.*;

import java.io.File;
import java.io.IOException;
import java.io.InterruptedIOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.security.MessageDigest;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.List;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.concurrent.atomic.AtomicInteger;
import okhttp3.MediaType;
import okhttp3.Protocol;
import okhttp3.Request;
import okhttp3.Response;
import okhttp3.ResponseBody;
import okio.Buffer;
import okio.BufferedSource;
import okio.Okio;
import okio.Source;
import okio.Timeout;
import org.junit.Rule;
import org.junit.Test;
import org.junit.rules.TemporaryFolder;

public final class OfflineModelDownloadTest {
    private static final String URL = "https://huggingface.co/official/model/resolve/" + "a".repeat(40) + "/model.onnx";
    private static final OfflineModelDownload.Cancel NEVER = () -> false;
    private static final OfflineModelDownload.Progress IGNORE = (received, total) -> {};
    private static final byte[] WEIGHT = "correct-model-weight".getBytes(StandardCharsets.UTF_8);
    @Rule public TemporaryFolder temporary = new TemporaryFolder();

    private OfflineModelDownload.Asset asset() throws Exception {
        return new OfflineModelDownload.Asset("model.onnx", URL, WEIGHT.length, sha(WEIGHT));
    }

    private File target() { return new File(temporary.getRoot(), "nested/model.onnx"); }
    private File part(File target) { return new File(target.getPath() + ".part"); }

    private void write(File target, byte[] bytes) throws Exception {
        Files.createDirectories(target.getParentFile().toPath());
        Files.write(target.toPath(), bytes);
    }

    private static String sha(byte[] bytes) throws Exception {
        StringBuilder result = new StringBuilder();
        for (byte value : MessageDigest.getInstance("SHA-256").digest(bytes)) result.append(String.format("%02x", value & 255));
        return result.toString();
    }

    private static Response response(Request request, int code, byte[] body, String... headers) {
        return response(request, code, ResponseBody.create(body, (MediaType) null), headers);
    }

    private static Response response(Request request, int code, ResponseBody body, String... headers) {
        Response.Builder result = new Response.Builder().request(request).protocol(Protocol.HTTP_1_1)
            .code(code).message("fixture").body(body);
        for (int i = 0; i < headers.length; i += 2) result.header(headers[i], headers[i + 1]);
        return result.build();
    }

    private static ResponseBody unknownLength(byte[] first, boolean broken) {
        return new ResponseBody() {
            private final BufferedSource source = Okio.buffer(new Source() {
                boolean emitted;
                @Override public long read(Buffer sink, long count) throws IOException {
                    if (emitted) {
                        if (broken) throw new IOException("fixture disconnect");
                        return -1;
                    }
                    emitted = true;
                    sink.write(first);
                    return first.length;
                }
                @Override public Timeout timeout() { return Timeout.NONE; }
                @Override public void close() {}
            });
            @Override public MediaType contentType() { return null; }
            @Override public long contentLength() { return -1; }
            @Override public BufferedSource source() { return source; }
        };
    }

    private static void fails(String code, Checked action) throws Exception {
        try { action.run(); fail("Expected " + code); }
        catch (OfflineModelDownload.Failure error) { assertEquals(code, error.code); assertEquals(code, error.getMessage()); }
    }
    private interface Checked { void run() throws Exception; }

    @Test public void completeDownloadPublishesOnlyTheVerifiedFile() throws Exception {
        File target = target();
        List<Long> progress = new ArrayList<>();
        OfflineModelDownload download = new OfflineModelDownload(request -> {
            assertFalse(target.exists());
            assertNull(request.header("Authorization"));
            assertNull(request.header("Cookie"));
            assertEquals("identity", request.header("Accept-Encoding"));
            return response(request, 200, WEIGHT);
        });
        download.fetch(asset(), target, NEVER, (received, total) -> {
            assertEquals(WEIGHT.length, total);
            assertTrue(received >= 0 && received <= total);
            progress.add(received);
        });
        assertArrayEquals(WEIGHT, Files.readAllBytes(target.toPath()));
        assertFalse(part(target).exists());
        assertEquals(Long.valueOf(WEIGHT.length), progress.get(progress.size()-1));
    }

    @Test public void reusesAnAlreadyVerifiedFileWithoutNetwork() throws Exception {
        File target = target(); write(target, WEIGHT);
        new OfflineModelDownload(request -> { throw new AssertionError("Network not needed"); })
            .fetch(asset(), target, NEVER, IGNORE);
        assertArrayEquals(WEIGHT, Files.readAllBytes(target.toPath()));
    }

    @Test public void resumesAtTheExactVerifiedContentRangeOffset() throws Exception {
        File target = target(); write(part(target), Arrays.copyOf(WEIGHT, 7));
        new OfflineModelDownload(request -> {
            assertEquals("bytes=7-", request.header("Range"));
            return response(request, 206, Arrays.copyOfRange(WEIGHT, 7, WEIGHT.length),
                "Content-Range", "bytes 7-" + (WEIGHT.length-1) + "/" + WEIGHT.length);
        }).fetch(asset(), target, NEVER, IGNORE);
        assertArrayEquals(WEIGHT, Files.readAllBytes(target.toPath()));
    }

    @Test public void serverIgnoringRangeRestartsRatherThanAppending() throws Exception {
        File target = target(); write(part(target), "old-prefix".getBytes(StandardCharsets.UTF_8));
        new OfflineModelDownload(request -> {
            assertEquals("bytes=10-", request.header("Range"));
            return response(request, 200, WEIGHT);
        }).fetch(asset(), target, NEVER, IGNORE);
        assertArrayEquals(WEIGHT, Files.readAllBytes(target.toPath()));
    }

    @Test public void rejectsMalformedRangesBeforeTouchingExistingPartialOrModel() throws Exception {
        for (String range : new String[] {"bytes 6-19/20", "bytes 7-19/21", "bytes 7-20/20", "bytes 7-6/20",
            "bytes 7-19/*", "bytes 999999999999999999999-19/20", "bytes */20", "invalid"}) {
            File target = target(); byte[] prefix = Arrays.copyOf(WEIGHT, 7);
            write(part(target), prefix); write(target, "previous-model".getBytes(StandardCharsets.UTF_8));
            OfflineModelDownload download = new OfflineModelDownload(request -> response(request, 206,
                Arrays.copyOfRange(WEIGHT, 7, WEIGHT.length), "Content-Range", range));
            fails("protocol", () -> download.fetch(asset(), target, NEVER, IGNORE));
            assertArrayEquals(prefix, Files.readAllBytes(part(target).toPath()));
            assertEquals("previous-model", new String(Files.readAllBytes(target.toPath()), StandardCharsets.UTF_8));
        }
    }

    @Test public void rejectedResumeFallsBackToOneFullRequest() throws Exception {
        File target = target(); write(part(target), Arrays.copyOf(WEIGHT, 7));
        AtomicInteger calls = new AtomicInteger();
        new OfflineModelDownload(request -> {
            if (calls.getAndIncrement() == 0) {
                assertEquals("bytes=7-", request.header("Range"));
                return response(request, 416, new byte[0], "Content-Range", "bytes */" + WEIGHT.length);
            }
            assertNull(request.header("Range"));
            return response(request, 200, WEIGHT);
        }).fetch(asset(), target, NEVER, IGNORE);
        assertEquals(2, calls.get());
        assertArrayEquals(WEIGHT, Files.readAllBytes(target.toPath()));
    }

    @Test public void validPartialResponsesContinueUntilTheObjectIsComplete() throws Exception {
        File target = target(); AtomicInteger calls = new AtomicInteger();
        new OfflineModelDownload(request -> {
            if (calls.getAndIncrement() == 0) return response(request, 206, Arrays.copyOf(WEIGHT, 7),
                "Content-Range", "bytes 0-6/" + WEIGHT.length);
            assertEquals("bytes=7-", request.header("Range"));
            return response(request, 206, Arrays.copyOfRange(WEIGHT, 7, WEIGHT.length),
                "Content-Range", "bytes 7-" + (WEIGHT.length-1) + "/" + WEIGHT.length);
        }).fetch(asset(), target, NEVER, IGNORE);
        assertEquals(2, calls.get());
        assertArrayEquals(WEIGHT, Files.readAllBytes(target.toPath()));
    }

    @Test public void disconnectedResponseRetainsRealReceivedBytesAndRetryResumesThem() throws Exception {
        File target = target(); byte[] prefix = Arrays.copyOf(WEIGHT, 7);
        OfflineModelDownload broken = new OfflineModelDownload(request -> response(request, 200, unknownLength(prefix, true)));
        fails("network", () -> broken.fetch(asset(), target, NEVER, IGNORE));
        assertFalse(target.exists());
        assertArrayEquals(prefix, Files.readAllBytes(part(target).toPath()));
        new OfflineModelDownload(request -> {
            assertEquals("bytes=7-", request.header("Range"));
            return response(request, 206, Arrays.copyOfRange(WEIGHT, 7, WEIGHT.length),
                "Content-Range", "bytes 7-" + (WEIGHT.length-1) + "/" + WEIGHT.length);
        }).fetch(asset(), target, NEVER, IGNORE);
        assertArrayEquals(WEIGHT, Files.readAllBytes(target.toPath()));
    }

    @Test public void truncatedUnknownLengthBodyIsNeverPublished() throws Exception {
        File target = target(); byte[] prefix = Arrays.copyOf(WEIGHT, 7);
        OfflineModelDownload broken = new OfflineModelDownload(request -> response(request, 200, unknownLength(prefix, false)));
        fails("size_mismatch", () -> broken.fetch(asset(), target, NEVER, IGNORE));
        assertFalse(target.exists());
        assertArrayEquals(prefix, Files.readAllBytes(part(target).toPath()));
    }

    @Test public void rejectsLengthMismatchAndOversizedStreamWithoutOverwritingPriorModel() throws Exception {
        File target = target(); write(target, "previous-model".getBytes(StandardCharsets.UTF_8));
        byte[] tooLarge = Arrays.copyOf(WEIGHT, WEIGHT.length+1);
        for (ResponseBody body : new ResponseBody[] {ResponseBody.create(tooLarge, (MediaType) null), unknownLength(tooLarge, false)}) {
            OfflineModelDownload download = new OfflineModelDownload(request -> response(request, 200, body));
            fails("size_mismatch", () -> download.fetch(asset(), target, NEVER, IGNORE));
            assertEquals("previous-model", new String(Files.readAllBytes(target.toPath()), StandardCharsets.UTF_8));
            assertTrue(part(target).length() <= WEIGHT.length);
        }
    }

    @Test public void checksumMismatchDeletesBadPartialAndRetainsThePreviousModel() throws Exception {
        File target = target(); write(target, "previous-model".getBytes(StandardCharsets.UTF_8));
        byte[] wrong = Arrays.copyOf(WEIGHT, WEIGHT.length); wrong[0]++;
        OfflineModelDownload download = new OfflineModelDownload(request -> response(request, 200, wrong));
        fails("checksum_mismatch", () -> download.fetch(asset(), target, NEVER, IGNORE));
        assertFalse(part(target).exists());
        assertEquals("previous-model", new String(Files.readAllBytes(target.toPath()), StandardCharsets.UTF_8));
    }

    @Test public void fullyReceivedPartialIsVerifiedAndPublishedWithoutAnotherRequest() throws Exception {
        File target = target(); write(part(target), WEIGHT);
        new OfflineModelDownload(request -> { throw new AssertionError("Network not needed"); })
            .fetch(asset(), target, NEVER, IGNORE);
        assertArrayEquals(WEIGHT, Files.readAllBytes(target.toPath()));
        assertFalse(part(target).exists());
    }

    @Test public void corruptedResumePrefixCannotPassTheFinalHash() throws Exception {
        File target = target(); write(part(target), "WRONG!!".getBytes(StandardCharsets.UTF_8));
        OfflineModelDownload download = new OfflineModelDownload(request -> response(request, 206,
            Arrays.copyOfRange(WEIGHT, 7, WEIGHT.length), "Content-Range", "bytes 7-" + (WEIGHT.length-1) + "/" + WEIGHT.length));
        fails("checksum_mismatch", () -> download.fetch(asset(), target, NEVER, IGNORE));
        assertFalse(part(target).exists()); assertFalse(target.exists());
    }

    @Test public void startupVerificationRejectsLinkedModelDirectories() throws Exception {
        File actual = new File(temporary.getRoot(), "actual/model.onnx");
        write(actual, WEIGHT);
        File linked = new File(temporary.getRoot(), "linked");
        Files.createSymbolicLink(linked.toPath(), actual.getParentFile().toPath());
        fails("protocol", () -> OfflineModelDownload.verified(asset(), new File(linked, "model.onnx"), NEVER));
        assertArrayEquals(WEIGHT, Files.readAllBytes(actual.toPath()));
    }

    @Test public void cancellationDuringFinalHashRetainsACompletePartialForNextAttempt() throws Exception {
        File target = target(); write(part(target), WEIGHT);
        AtomicInteger checks = new AtomicInteger();
        // Initial checks pass; the hash loop is cancelled before publication.
        try {
            new OfflineModelDownload(request -> { throw new AssertionError("Network not needed"); })
                .fetch(asset(), target, () -> checks.incrementAndGet() >= 4, IGNORE);
            fail("Cancellation must stop publication");
        } catch (InterruptedIOException expected) { assertEquals("cancelled", expected.getMessage()); }
        assertArrayEquals(WEIGHT, Files.readAllBytes(part(target).toPath()));
        assertFalse(target.exists());
    }

    @Test public void cancellationAfterReceiveRetainsThePartialWithoutMarkingItReady() throws Exception {
        File target = target(); AtomicBoolean cancel = new AtomicBoolean();
        try {
            new OfflineModelDownload(request -> response(request, 200, WEIGHT)).fetch(asset(), target, cancel::get,
                (received, total) -> { if (received > 0) cancel.set(true); });
            fail("Cancellation must stop publication");
        } catch (InterruptedIOException expected) { assertEquals("cancelled", expected.getMessage()); }
        assertFalse(target.exists());
        assertArrayEquals(WEIGHT, Files.readAllBytes(part(target).toPath()));
    }

    @Test public void approvedRedirectRetainsRangeButNeverAddsCredentials() throws Exception {
        File target = target(); write(part(target), Arrays.copyOf(WEIGHT, 7));
        AtomicInteger calls = new AtomicInteger();
        new OfflineModelDownload(request -> {
            assertNull(request.header("Authorization")); assertNull(request.header("Cookie"));
            assertEquals("bytes=7-", request.header("Range"));
            if (calls.getAndIncrement() == 0) return response(request, 302, new byte[0], "Location",
                "https://cas-bridge.xethub.hf.co/object?public-signature=example");
            assertEquals("cas-bridge.xethub.hf.co", request.url().host());
            return response(request, 206, Arrays.copyOfRange(WEIGHT, 7, WEIGHT.length),
                "Content-Range", "bytes 7-" + (WEIGHT.length-1) + "/" + WEIGHT.length);
        }).fetch(asset(), target, NEVER, IGNORE);
        assertEquals(2, calls.get());
        assertArrayEquals(WEIGHT, Files.readAllBytes(target.toPath()));
    }

    @Test public void maliciousRedirectIsRejectedBeforeItsRequest() throws Exception {
        File target = target(); AtomicInteger calls = new AtomicInteger();
        OfflineModelDownload download = new OfflineModelDownload(request -> {
            calls.incrementAndGet();
            return response(request, 302, new byte[0], "Location", "https://huggingface.co.attacker.test/steal");
        });
        fails("redirect", () -> download.fetch(asset(), target, NEVER, IGNORE));
        assertEquals(1, calls.get()); assertFalse(target.exists());
    }

    @Test public void redirectLoopsAreBounded() throws Exception {
        File target = target(); AtomicInteger calls = new AtomicInteger();
        OfflineModelDownload download = new OfflineModelDownload(request -> {
            calls.incrementAndGet(); return response(request, 302, new byte[0], "Location", URL);
        });
        fails("redirect", () -> download.fetch(asset(), target, NEVER, IGNORE));
        assertEquals(6, calls.get());
    }

    @Test public void immutableSourceAndLocalAssetPathsHaveStrictBoundaries() throws Exception {
        assertTrue(OfflineModelDownload.allowedSource(URL));
        assertTrue(OfflineModelDownload.safeName("vocab/tokenizer.json"));
        for (String name : new String[] {"", "/model", "../model", "vocab/../model", "vocab/./model", "a//b",
            "a\\b", "a/", "a\u0000b"}) assertFalse(name, OfflineModelDownload.safeName(name));
        for (String source : new String[] {URL.replace("/resolve/" + "a".repeat(40), "/resolve/main"),
            URL + "?download=true", URL + "#part", URL.replace("https:", "http:"),
            URL.replace("huggingface.co", "huggingface.co.attacker.test"), URL.replace("huggingface.co", "user@huggingface.co"),
            URL.replace("huggingface.co", "huggingface.co:444"), "file:///tmp/model.onnx"}) {
            assertFalse(source, OfflineModelDownload.allowedSource(source));
        }
        for (String source : new String[] {"https://cdn-lfs.huggingface.co/object", "https://cdn-lfs-us-1.huggingface.co/object",
            "https://cdn-lfs-eu-1.huggingface.co/object", "https://us.aws.cdn.hf.co/object?sig=example"}) {
            assertTrue(source, OfflineModelDownload.allowedDownload(source));
        }
        for (String source : new String[] {"https://hf.co/object", "http://cdn-lfs.huggingface.co/object",
            "https://evil-hf.co/object", "https://a.hf.co.attacker.test/object", "https://attacker.test/object"}) {
            assertFalse(source, OfflineModelDownload.allowedDownload(source));
        }
        try { new OfflineModelDownload.Asset("../model", URL, WEIGHT.length, sha(WEIGHT)); fail("Unsafe path"); }
        catch (IllegalArgumentException expected) { assertEquals("invalid_model_asset", expected.getMessage()); }
    }

    @Test public void rejectsSymlinkDestinationAndParent() throws Exception {
        File outside = temporary.newFile("outside");
        File target = target(); Files.createDirectories(target.getParentFile().toPath());
        Files.createSymbolicLink(target.toPath(), outside.toPath());
        OfflineModelDownload download = new OfflineModelDownload(request -> { throw new AssertionError("Unsafe path must not use network"); });
        fails("protocol", () -> download.fetch(asset(), target, NEVER, IGNORE));
        Files.delete(target.toPath()); Files.delete(target.getParentFile().toPath());
        Files.createSymbolicLink(target.getParentFile().toPath(), temporary.newFolder("other").toPath());
        fails("protocol", () -> download.fetch(asset(), target, NEVER, IGNORE));
        assertEquals(0, outside.length());
    }

    @Test public void compressedModelBytesAreRejectedBeforeWriting() throws Exception {
        File target = target();
        OfflineModelDownload download = new OfflineModelDownload(request -> response(request, 200, WEIGHT, "Content-Encoding", "gzip"));
        fails("protocol", () -> download.fetch(asset(), target, NEVER, IGNORE));
        assertFalse(target.exists()); assertFalse(part(target).exists());
    }
}
