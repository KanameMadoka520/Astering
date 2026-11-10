package space.tcymc.astering;

import static org.junit.Assert.*;

import java.net.URI;
import java.util.HashSet;
import java.util.Set;
import org.junit.Test;

public class OfflineModelCatalogTest {
    @Test public void registryUsesCompleteImmutableRevisionsAndExactSizes() {
        assertEquals(3, OfflineModelCatalog.all().size());
        assertEquals(239549735L, OfflineModelCatalog.get(OfflineModelCatalog.SENSEVOICE).bytes());
        assertEquals(175693762L, OfflineModelCatalog.get(OfflineModelCatalog.X_ASR).bytes());
        assertEquals(987015347L, OfflineModelCatalog.get(OfflineModelCatalog.QWEN).bytes());
        Set<String> ids = new HashSet<>();
        for (OfflineModelCatalog.Model model : OfflineModelCatalog.all()) {
            assertTrue(ids.add(model.id));
            assertFalse(model.descriptionZh.isBlank());
            assertFalse(model.descriptionEn.isBlank());
            Set<String> names = new HashSet<>();
            for (OfflineModelDownload.Asset asset : model.assets) {
                assertTrue(names.add(asset.name));
                assertFalse(asset.name.startsWith("/"));
                assertFalse(asset.name.contains(".."));
                URI url = URI.create(asset.url);
                assertEquals("https", url.getScheme());
                assertEquals("huggingface.co", url.getHost());
                assertNull(url.getUserInfo());
                assertNull(url.getQuery());
                assertNull(url.getFragment());
                assertTrue(url.getPath().matches("/[^/]+/[^/]+/resolve/[a-f0-9]{40}/.+"));
                assertTrue(url.getPath().endsWith("/" + asset.name));
                assertTrue(asset.sha256.matches("[a-f0-9]{64}"));
                assertTrue(asset.bytes > 0);
                assertTrue(asset.bytes < 1_000_000_000L);
            }
        }
    }

    @Test public void registryCannotBeChangedAndUnknownModelDoesNotFallBack() {
        assertNull(OfflineModelCatalog.get("../../model"));
        assertNull(OfflineModelCatalog.get("unknown"));
        assertNull(OfflineModelCatalog.get(null));
        assertThrows(UnsupportedOperationException.class, () -> OfflineModelCatalog.all().clear());
        assertThrows(UnsupportedOperationException.class,
            () -> OfflineModelCatalog.get(OfflineModelCatalog.SENSEVOICE).assets.clear());
    }
}
