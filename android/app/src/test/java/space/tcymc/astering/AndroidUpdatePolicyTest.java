package space.tcymc.astering;

import static org.junit.Assert.*;
import org.json.JSONArray;
import org.json.JSONObject;
import org.junit.Test;

public final class AndroidUpdatePolicyTest {
    private JSONObject release(int version) {
        String tag = "v2.7.1-aster." + version;
        String name = "astering-" + tag + "-android.apk";
        JSONObject apk = new JSONObject().put("name", name).put("state", "uploaded")
            .put("size", 264000000).put("digest", "sha256:" + "a".repeat(64))
            .put("browser_download_url", "https://github.com/KanameMadoka520/Astering/releases/download/" + tag + "/" + name);
        return new JSONObject().put("tag_name", tag).put("draft", false).put("prerelease", false)
            .put("assets", new JSONArray().put(apk));
    }

    @Test public void usesHighestAndroidVersionRatherThanServerReleaseOrListPosition() {
        JSONObject server = release(99).put("assets", new JSONArray());
        AndroidUpdatePolicy.Update update = AndroidUpdatePolicy.newest(
            new JSONArray().put(release(67)).put(server).put(release(70)).put(release(68)), 66);
        assertNotNull(update);
        assertEquals(70, update.code());
        assertEquals("2.7.1-aster.70", update.version());
        assertEquals("a".repeat(64), update.sha256());
    }

    @Test public void installedAndOlderVersionsNeverTriggerUpdate() {
        assertNull(AndroidUpdatePolicy.newest(new JSONArray().put(release(66)).put(release(65)), 66));
    }

    @Test public void draftsPrereleasesAndUnknownReleaseStatesAreIgnored() {
        assertNull(AndroidUpdatePolicy.newest(new JSONArray()
            .put(release(67).put("draft", true)).put(release(68).put("prerelease", true))
            .put(release(69).put("draft", JSONObject.NULL)), 66));
    }

    @Test public void requiresExactNameCanonicalRepositoryAndUploadedAsset() {
        for (String key : new String[] {"name", "browser_download_url", "state"}) {
            JSONObject release = release(67);
            release.getJSONArray("assets").getJSONObject(0).put(key, "https://attacker.test/payload.apk");
            assertNull(AndroidUpdatePolicy.newest(new JSONArray().put(release), 66));
        }
    }

    @Test public void rejectsMissingHashAndInvalidOrUnboundedSize() {
        for (Object size : new Object[] {0, -1, AndroidUpdatePolicy.MAX_APK_BYTES + 1}) {
            JSONObject release = release(67);
            release.getJSONArray("assets").getJSONObject(0).put("size", size);
            assertNull(AndroidUpdatePolicy.newest(new JSONArray().put(release), 66));
        }
        for (String hash : new String[] {"", "sha1:" + "a".repeat(40), "sha256:" + "z".repeat(64)}) {
            JSONObject release = release(67);
            release.getJSONArray("assets").getJSONObject(0).put("digest", hash);
            assertNull(AndroidUpdatePolicy.newest(new JSONArray().put(release), 66));
        }
    }

    @Test public void malformedTagsCannotBecomeVersionCodes() {
        for (String tag : new String[] {"v2.7.1-aster.0", "v2.7.1-aster.99999999999999999", "v2.7.1-tcymc.99", "android-latest"}) {
            assertNull(AndroidUpdatePolicy.newest(new JSONArray().put(release(67).put("tag_name", tag)), 66));
        }
    }

    @Test public void redirectDestinationsStayOnExactHttpsGithubAssetHosts() {
        assertTrue(AndroidUpdatePolicy.allowedDownload("https://github.com/KanameMadoka520/Astering/releases/download/v/a.apk"));
        assertTrue(AndroidUpdatePolicy.allowedDownload("https://release-assets.githubusercontent.com/github-production-release-asset/a?sig=public"));
        assertTrue(AndroidUpdatePolicy.allowedDownload("https://objects.githubusercontent.com/github-production-release-asset/a"));
        for (String bad : new String[] {"http://github.com/a", "https://github.com.attacker.test/a",
            "https://attacker.test/a", "https://github.com:444/a", "https://user@github.com/a",
            "file:///tmp/a.apk", "https://github.com/a#fragment", "https://github.com\\@attacker.test/a"}) {
            assertFalse(bad, AndroidUpdatePolicy.allowedDownload(bad));
        }
    }
}
