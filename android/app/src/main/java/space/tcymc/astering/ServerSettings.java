package space.tcymc.astering;

import android.content.Context;
import android.content.SharedPreferences;

/** A new versioned preference: legacy WebView URLs/cookies are never an implicit server selection. */
final class ServerSettings {
    private final SharedPreferences preferences;
    ServerSettings(Context context) { preferences = context.getSharedPreferences("selected-server-v1", Context.MODE_PRIVATE); }
    SitePolicy selected() {
        if (!preferences.getBoolean("explicit_choice", false)) return null;
        return SitePolicy.parseServer(preferences.getString("origin", ""));
    }
    boolean save(SitePolicy site) {
        if (site == null) return preferences.edit().clear().commit();
        return preferences.edit().putString("origin", site.origin).putBoolean("explicit_choice", true).commit();
    }
}
