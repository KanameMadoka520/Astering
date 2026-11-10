package space.tcymc.astering;

import static org.junit.Assert.*;

import java.io.File;
import java.util.HashSet;
import java.util.Set;
import javax.xml.parsers.DocumentBuilderFactory;
import org.junit.Test;
import org.w3c.dom.Element;
import org.w3c.dom.NodeList;

public final class WebAudioManifestTest {
    @Test public void webViewAudioCanSelectAnInputAfterTheUserGrantsMicrophoneAccess() throws Exception {
        DocumentBuilderFactory factory = DocumentBuilderFactory.newInstance();
        factory.setNamespaceAware(true);
        factory.setFeature("http://apache.org/xml/features/disallow-doctype-decl", true);
        NodeList declarations = factory.newDocumentBuilder().parse(new File("src/main/AndroidManifest.xml"))
            .getElementsByTagName("uses-permission");
        Set<String> permissions = new HashSet<>();
        for (int index = 0; index < declarations.getLength(); index++) {
            permissions.add(((Element) declarations.item(index))
                .getAttributeNS("http://schemas.android.com/apk/res/android", "name"));
        }
        assertTrue("Android still requires the user's microphone grant", permissions.contains("android.permission.RECORD_AUDIO"));
        assertTrue("Chromium cannot enumerate/select a communication input without this normal permission",
            permissions.contains("android.permission.MODIFY_AUDIO_SETTINGS"));
    }
}
