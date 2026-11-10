package space.tcymc.astering;

import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.InterruptedIOException;
import java.nio.file.Files;
import java.nio.file.LinkOption;
import java.nio.file.Path;
import java.nio.file.StandardCopyOption;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.regex.Matcher;
import java.util.regex.Pattern;
import okhttp3.Authenticator;
import okhttp3.Call;
import okhttp3.CookieJar;
import okhttp3.Dispatcher;
import okhttp3.HttpUrl;
import okhttp3.OkHttpClient;
import okhttp3.Request;
import okhttp3.Response;
import okhttp3.ResponseBody;

/** Public immutable weights have a separate transport from website credentials and user files. */
final class OfflineModelDownload {
    private static final Pattern PART_RANGE = Pattern.compile("bytes ([0-9]+)-([0-9]+)/([0-9]+)");
    private static final String USER_AGENT = "Astering-Offline-Models";

    static final class Asset {
        final String name;
        final String url;
        final long bytes;
        final String sha256;

        Asset(String name, String url, long bytes, String sha256) {
            if (!safeName(name) || !allowedSource(url) || bytes <= 0
                || sha256 == null || !sha256.matches("[a-f0-9]{64}")) {
                throw new IllegalArgumentException("invalid_model_asset");
            }
            this.name = name;
            this.url = url;
            this.bytes = bytes;
            this.sha256 = sha256;
        }
    }

    static final class Failure extends IOException {
        final String code;
        Failure(String code) { super(code); this.code = code; }
        Failure(String code, Throwable cause) { super(code, cause); this.code = code; }
    }

    interface Cancel { boolean cancelled(); }
    interface Progress { void update(long received, long total); }
    interface Transport { Response execute(Request request) throws IOException; }

    private final Transport transport;
    private final AtomicBoolean fetching = new AtomicBoolean();
    private volatile Call active;
    private volatile Cancel signal;

    OfflineModelDownload(OkHttpClient source) {
        OkHttpClient.Builder builder = source.newBuilder()
            .authenticator(Authenticator.NONE).proxyAuthenticator(Authenticator.NONE)
            .cookieJar(CookieJar.NO_COOKIES).cache(null)
            .dispatcher(new Dispatcher())
            .connectTimeout(20, TimeUnit.SECONDS).readTimeout(45, TimeUnit.SECONDS)
            .callTimeout(30, TimeUnit.MINUTES)
            .followRedirects(false).followSslRedirects(false);
        builder.interceptors().clear();
        builder.networkInterceptors().clear();
        OkHttpClient http = builder.build();
        transport = request -> {
            Call call = http.newCall(request);
            active = call;
            Cancel current = signal;
            if (current != null && current.cancelled()) call.cancel();
            return call.execute();
        };
    }

    // Test transport supplies protocol responses without relaxing the production URL policy.
    OfflineModelDownload(Transport transport) {
        this.transport = transport;
    }

    void cancel() {
        Call current = active;
        if (current != null) current.cancel();
    }

    void fetch(Asset asset, File destination, Cancel cancel, Progress progress) throws IOException {
        if (!fetching.compareAndSet(false, true)) throw new Failure("busy");
        signal = cancel;
        try {
            fetchFile(asset, destination, cancel, progress);
        } catch (IOException error) {
            Call current = active;
            if (cancel.cancelled() || Thread.currentThread().isInterrupted()
                || current != null && current.isCanceled()) {
                InterruptedIOException cancelled = new InterruptedIOException("cancelled");
                cancelled.initCause(error);
                throw cancelled;
            }
            if (error instanceof Failure) throw error;
            throw new Failure("storage", error);
        } finally {
            active = null;
            signal = null;
            fetching.set(false);
        }
    }

    private void fetchFile(Asset asset, File destination, Cancel cancel, Progress progress) throws IOException {
        checkCancelled(cancel);
        checkPath(destination.toPath());
        File parent = destination.getAbsoluteFile().getParentFile();
        if (parent == null) throw new Failure("protocol");
        Files.createDirectories(parent.toPath());
        File part = new File(destination.getPath() + ".part");
        checkPath(part.toPath());
        if (verified(asset, destination, cancel)) {
            progress.update(asset.bytes, asset.bytes);
            return;
        }
        if (part.exists() && part.length() > asset.bytes) Files.delete(part.toPath());
        boolean fromZero = false;
        while (part.length() < asset.bytes) {
            checkCancelled(cancel);
            long offset = fromZero ? 0 : part.length();
            progress.update(offset, asset.bytes);
            try (Response response = request(asset.url, offset, cancel)) {
                if (response.code() == 416 && offset > 0) {
                    // Some CDNs reject Range; retry the full immutable object without appending.
                    fromZero = true;
                    continue;
                }
                long expectedEnd;
                boolean append;
                if (response.code() == 200) {
                    offset = 0;
                    expectedEnd = asset.bytes;
                    append = false;
                } else if (response.code() == 206) {
                    long[] range = range(response.header("Content-Range"));
                    if (range == null || range[0] != offset || range[2] != asset.bytes
                        || range[1] < range[0] || range[1] >= asset.bytes) {
                        throw new Failure("protocol");
                    }
                    expectedEnd = range[1] + 1;
                    append = offset > 0;
                } else {
                    throw new Failure(response.code() == 416 ? "protocol" : "network");
                }
                ResponseBody body = response.body();
                String encoding = response.header("Content-Encoding");
                if (body == null || encoding != null && !encoding.equalsIgnoreCase("identity")) {
                    throw new Failure("protocol");
                }
                if (body.contentLength() >= 0 && body.contentLength() != expectedEnd-offset) {
                    throw new Failure("size_mismatch");
                }
                checkCancelled(cancel);
                checkPath(part.toPath());
                long received = offset;
                try (InputStream input = body.byteStream(); FileOutputStream output = new FileOutputStream(part, append)) {
                    progress.update(received, asset.bytes);
                    byte[] buffer = new byte[65536];
                    int size;
                    while ((size = readNetwork(input, buffer)) != -1) {
                        checkCancelled(cancel);
                        if (size > expectedEnd-received) throw new Failure("size_mismatch");
                        output.write(buffer, 0, size);
                        received += size;
                        progress.update(received, asset.bytes);
                    }
                    if (received != expectedEnd) throw new Failure("size_mismatch");
                    output.getFD().sync();
                }
                fromZero = false;
            }
        }
        if (!verified(asset, part, cancel)) {
            Files.deleteIfExists(part.toPath());
            throw new Failure("checksum_mismatch");
        }
        checkCancelled(cancel);
        // Both paths are siblings on app-private storage; replacement leaves the previous model intact on failure.
        Files.move(part.toPath(), destination.toPath(), StandardCopyOption.ATOMIC_MOVE,
            StandardCopyOption.REPLACE_EXISTING);
        progress.update(asset.bytes, asset.bytes);
    }

    private Response request(String initial, long offset, Cancel cancel) throws IOException {
        String url = initial;
        for (int redirects = 0; redirects <= 5; redirects++) {
            checkCancelled(cancel);
            if (!allowedDownload(url)) throw new Failure("redirect");
            Request.Builder builder = new Request.Builder().url(url)
                .header("Accept-Encoding", "identity").header("User-Agent", USER_AGENT);
            if (offset > 0) builder.header("Range", "bytes=" + offset + "-");
            Response response;
            try { response = transport.execute(builder.build()); }
            catch (IOException error) { throw new Failure("network", error); }
            try {
                checkCancelled(cancel);
                if (!response.isRedirect()) return response;
                String location = response.header("Location");
                HttpUrl next = location == null ? null : response.request().url().resolve(location);
                if (next == null || redirects == 5 || !allowedDownload(next.toString())) {
                    throw new Failure("redirect");
                }
                url = next.toString();
            } catch (IOException error) {
                response.close();
                throw error;
            }
            response.close();
        }
        throw new Failure("redirect");
    }

    static boolean verified(Asset asset, File file, Cancel cancel) throws IOException {
        checkCancelled(cancel);
        // Also used before cleanup and at startup: reject linked ancestors before reading any model bytes.
        checkPath(file.toPath());
        if (!Files.isRegularFile(file.toPath(), LinkOption.NOFOLLOW_LINKS) || file.length() != asset.bytes) return false;
        MessageDigest digest;
        try { digest = MessageDigest.getInstance("SHA-256"); }
        catch (NoSuchAlgorithmException impossible) { throw new IllegalStateException(impossible); }
        long received = 0;
        try (InputStream input = new FileInputStream(file)) {
            byte[] buffer = new byte[65536];
            int size;
            while ((size = input.read(buffer)) != -1) {
                checkCancelled(cancel);
                if (size > asset.bytes-received) return false;
                received += size;
                digest.update(buffer, 0, size);
            }
        }
        if (received != asset.bytes) return false;
        byte[] bytes = digest.digest();
        StringBuilder hex = new StringBuilder(64);
        for (byte value : bytes) hex.append(Character.forDigit((value >>> 4) & 15, 16)).append(Character.forDigit(value & 15, 16));
        return hex.toString().equals(asset.sha256);
    }

    static boolean safeName(String name) {
        if (name == null || name.isEmpty() || name.length() > 256) return false;
        for (String segment : name.split("/", -1)) {
            if (segment.equals(".") || segment.equals("..") || !segment.matches("[A-Za-z0-9][A-Za-z0-9._-]*")) return false;
        }
        return true;
    }

    static boolean allowedSource(String value) {
        HttpUrl url = parse(value);
        if (url == null || !url.host().equals("huggingface.co") || url.query() != null) return false;
        java.util.List<String> parts = url.pathSegments();
        if (parts.size() < 5 || !safeName(parts.get(0)) || !safeName(parts.get(1))
            || !parts.get(2).equals("resolve") || !parts.get(3).matches("[a-f0-9]{40}")) return false;
        for (String part : parts) if (part.contains("/") || !safeName(part)) return false;
        return true;
    }

    static boolean allowedDownload(String value) {
        HttpUrl url = parse(value);
        if (url == null) return false;
        String host = url.host();
        return host.equals("huggingface.co") || host.equals("cdn-lfs.huggingface.co")
            || host.equals("cdn-lfs-us-1.huggingface.co") || host.equals("cdn-lfs-eu-1.huggingface.co")
            || host.endsWith(".hf.co");
    }

    private static HttpUrl parse(String value) {
        try {
            if (value == null || value.contains("\\")) return null;
            HttpUrl url = HttpUrl.get(value);
            if (!url.isHttps() || url.port() != 443 || !url.username().isEmpty()
                || !url.password().isEmpty() || url.fragment() != null) return null;
            return url;
        } catch (IllegalArgumentException error) { return null; }
    }

    private static int readNetwork(InputStream input, byte[] buffer) throws IOException {
        try { return input.read(buffer); }
        catch (IOException error) { throw new Failure("network", error); }
    }

    private static long[] range(String value) {
        if (value == null) return null;
        Matcher match = PART_RANGE.matcher(value);
        if (!match.matches()) return null;
        try { return new long[] { Long.parseLong(match.group(1)), Long.parseLong(match.group(2)), Long.parseLong(match.group(3)) }; }
        catch (NumberFormatException error) { return null; }
    }

    private static void checkPath(Path path) throws IOException {
        Path absolute = path.toAbsolutePath();
        if (!absolute.equals(absolute.normalize())) throw new Failure("protocol");
        for (Path current = absolute; current != null; current = current.getParent()) {
            if (Files.isSymbolicLink(current)) throw new Failure("protocol");
        }
        if (Files.exists(absolute, LinkOption.NOFOLLOW_LINKS)
            && !Files.isRegularFile(absolute, LinkOption.NOFOLLOW_LINKS)) throw new Failure("protocol");
    }

    private static void checkCancelled(Cancel cancel) throws InterruptedIOException {
        if (cancel.cancelled() || Thread.currentThread().isInterrupted()) throw new InterruptedIOException("cancelled");
    }
}
