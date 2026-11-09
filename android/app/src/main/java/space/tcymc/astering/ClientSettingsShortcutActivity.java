package space.tcymc.astering;

import android.app.Activity;
import android.content.Intent;
import android.os.Bundle;

/** Static shortcuts otherwise clear the running task. This empty-affinity trampoline preserves it. */
public final class ClientSettingsShortcutActivity extends Activity {
    @Override public void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        // Never forward a caller URL, extras, flags or action into the privileged application window.
        startActivity(new Intent(this, MainActivity.class)
            .setAction(MainActivity.CLIENT_SETTINGS_ACTION)
            .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_CLEAR_TOP | Intent.FLAG_ACTIVITY_SINGLE_TOP));
        finish();
    }
}
