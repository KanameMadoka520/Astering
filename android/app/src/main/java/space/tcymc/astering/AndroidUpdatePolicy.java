package space.tcymc.astering;

import java.net.URI;
import java.util.Arrays;
import java.util.List;
import java.util.regex.Matcher;
import java.util.regex.Pattern;
import org.json.JSONArray;
import org.json.JSONObject;

/** Public GitHub metadata is separate from the user's selected Astering server. */
final class AndroidUpdatePolicy {
    static final String REPOSITORY = "KanameMadoka520/Astering";
    static final String RELEASES_API = "https://api.github.com/repos/" + REPOSITORY + "/releases";
    static final long MAX_APK_BYTES = 600L * 1024 * 1024;
    private static final Pattern TAG = Pattern.compile("v[0-9]+\\.[0-9]+\\.[0-9]+-aster\\.([1-9][0-9]{0,8})");
    private static final List<String> DOWNLOAD_HOSTS = Arrays.asList(
        "github.com", "release-assets.githubusercontent.com", "objects.githubusercontent.com");

    record Update(int code, String version, String tag, String name, String url, long size, String sha256) {}

    private AndroidUpdatePolicy() {}

    static Update newest(JSONArray releases, int installedCode) {
        Update best = null;
        for (int i = 0; i < releases.length(); i++) {
            JSONObject release = releases.optJSONObject(i);
            if (release == null || release.optBoolean("draft", true) || release.optBoolean("prerelease", true)) continue;
            String tag = release.optString("tag_name");
            Matcher matcher = TAG.matcher(tag);
            if (!matcher.matches()) continue;
            int code = Integer.parseInt(matcher.group(1));
            if (code <= installedCode || (best != null && code <= best.code())) continue;
            JSONArray assets = release.optJSONArray("assets");
            if (assets == null) continue;
            String expected = "astering-" + tag + "-android.apk";
            for (int j = 0; j < assets.length(); j++) {
                JSONObject asset = assets.optJSONObject(j);
                if (asset == null || !expected.equals(asset.optString("name"))
                    || !"uploaded".equals(asset.optString("state"))) continue;
                long size = asset.optLong("size", -1);
                String digest = asset.optString("digest");
                String url = "https://github.com/" + REPOSITORY + "/releases/download/" + tag + "/" + expected;
                if (size <= 0 || size > MAX_APK_BYTES || !digest.matches("sha256:[a-f0-9]{64}")
                    || !url.equals(asset.optString("browser_download_url"))) continue;
                best = new Update(code, tag.substring(1), tag, expected, url, size, digest.substring(7));
            }
        }
        return best;
    }

    static boolean allowedDownload(String raw) {
        try {
            URI uri = URI.create(raw);
            return "https".equals(uri.getScheme()) && DOWNLOAD_HOSTS.contains(uri.getHost())
                && (uri.getPort() == -1 || uri.getPort() == 443)
                && uri.getRawUserInfo() == null && uri.getRawFragment() == null;
        } catch (IllegalArgumentException | NullPointerException ignored) {
            return false;
        }
    }
}
