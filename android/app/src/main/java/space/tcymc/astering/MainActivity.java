package space.tcymc.astering;

import android.Manifest;
import android.app.Activity;
import android.app.AlertDialog;
import android.content.ActivityNotFoundException;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.graphics.Color;
import android.net.Uri;
import android.net.http.SslError;
import android.os.Build;
import android.os.Bundle;
import android.view.View;
import android.view.WindowManager;
import android.webkit.CookieManager;
import android.webkit.PermissionRequest;
import android.webkit.SslErrorHandler;
import android.webkit.ValueCallback;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceError;
import android.webkit.WebResourceRequest;
import android.webkit.WebSettings;
import android.webkit.WebStorage;
import android.webkit.WebViewDatabase;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.Button;
import android.widget.EditText;
import android.widget.ScrollView;
import android.widget.LinearLayout;
import android.widget.TextView;
import androidx.webkit.JavaScriptReplyProxy;
import androidx.webkit.WebViewCompat;
import androidx.webkit.WebStorageCompat;
import androidx.webkit.WebViewFeature;
import java.util.Arrays;
import java.util.Collections;
import java.util.UUID;
import org.json.JSONObject;

public final class MainActivity extends Activity {
    static final String CLIENT_SETTINGS_ACTION = "space.tcymc.astering.OPEN_CLIENT_SETTINGS";
    private static final java.util.concurrent.atomic.AtomicInteger REQUEST_CODES = new java.util.concurrent.atomic.AtomicInteger(1024);
    private int microphoneRequest = -1;
    private int notificationRequest = -1;
    private int fileRequest = -1;
    private long fileDocument;
    private SitePolicy fileSite;
    private WebView fileWeb;
    private AsteringApplication app;
    private WebView web;
    private SitePolicy webSite;
    private LinearLayout root;
    private AndroidUpdater updater;
    private boolean switchingServer;
    private AlertDialog clientSettingsDialog;
    private OfflineModelsDialog modelsDialog;
    private boolean pendingClientSettings;
    private AlertDialog serverDialog;
    private AlertDialog confirmDialog;
    private AlertDialog legacyDialog;
    private String legacyOffered = "";
    private LinearLayout errorPanel;
    private JavaScriptReplyProxy replyProxy;
    private long document;
    private boolean visible;
    private boolean resumed;
    private boolean rendererGone;
    private PendingStart pendingStart;
    private AlertDialog startDialog;
    private PermissionRequest browserPermission;
    private ValueCallback<Uri[]> fileCallback;
    private long pendingOpenNote;
    private long pendingOpenUser;
    private String pendingOpenSid = "";
    private String pendingOpenOrigin = "";

    @Override public void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        app = (AsteringApplication) getApplication();
        app.attach(this);
        boolean shortcut = CLIENT_SETTINGS_ACTION.equals(getIntent().getAction());
        pendingClientSettings = shortcut || savedInstanceState != null && savedInstanceState.getBoolean("open_client_settings");
        if (shortcut) setIntent(new Intent(this, MainActivity.class).setAction(Intent.ACTION_MAIN));
        else rememberOpenNote(getIntent());
        updater = new AndroidUpdater(this);
        root = new LinearLayout(this);
        root.setOrientation(LinearLayout.VERTICAL);
        root.setBackgroundColor(Color.rgb(248, 250, 252));
        root.setOnApplyWindowInsetsListener((view, insets) -> {
            if (Build.VERSION.SDK_INT >= 30) {
                android.graphics.Insets bars = insets.getInsets(android.view.WindowInsets.Type.systemBars()
                    | android.view.WindowInsets.Type.displayCutout());
                android.graphics.Insets keyboard = insets.getInsets(android.view.WindowInsets.Type.ime());
                view.setPadding(bars.left, bars.top, bars.right, Math.max(bars.bottom, keyboard.bottom));
            } else {
                view.setPadding(insets.getSystemWindowInsetLeft(), insets.getSystemWindowInsetTop(),
                    insets.getSystemWindowInsetRight(), insets.getSystemWindowInsetBottom());
            }
            return insets;
        });
        setContentView(root);
        if (Build.VERSION.SDK_INT >= 33) {
            getOnBackInvokedDispatcher().registerOnBackInvokedCallback(android.window.OnBackInvokedDispatcher.PRIORITY_DEFAULT,
                () -> {
                    if (web != null && !rendererGone && web.canGoBack()) web.goBack();
                    else finish();
                });
        }
        if (app.serverChange != null) { switchingServer = true; showServerProgress(); }
        else if (app.site == null) showServerForm();
        else showSelectedServer();
    }

    @Override public void onConfigurationChanged(android.content.res.Configuration configuration) {
        super.onConfigurationChanged(configuration);
        // Keep the existing SPA, drafts and scroll position when the display resizes or rotates.
        if (web != null && !rendererGone) web.invalidate();
    }

    private int dp(int value) {
        return Math.round(value * getResources().getDisplayMetrics().density);
    }

    /** This form intentionally does not use old cookies, URL history or the legacy migration origin. */
    private void showServerForm() {
        root.removeAllViews();
        ScrollView scroll = new ScrollView(this);
        LinearLayout form = new LinearLayout(this);
        form.setOrientation(LinearLayout.VERTICAL);
        form.setPadding(dp(24), dp(32), dp(24), dp(24));
        TextView title = new TextView(this);
        title.setText(R.string.server_title);
        title.setTextSize(24);
        title.setTextColor(Color.rgb(15, 23, 42));
        form.addView(title);
        TextView help = new TextView(this);
        help.setText(R.string.server_help);
        help.setPadding(0, dp(16), 0, dp(12));
        form.addView(help);
        EditText input = serverInput("");
        form.addView(input, new LinearLayout.LayoutParams(-1, -2));
        Button connect = new Button(this);
        connect.setText(R.string.server_connect);
        connect.setOnClickListener(v -> confirmServer(input));
        form.addView(connect);
        Button updates = new Button(this);
        updates.setText(R.string.update_check);
        updates.setOnClickListener(v -> updater.check(true));
        form.addView(updates);
        scroll.addView(form);
        root.addView(scroll, new LinearLayout.LayoutParams(-1, -1));
    }

    private EditText serverInput(String value) {
        EditText input = new EditText(this);
        input.setSingleLine(true);
        input.setInputType(android.text.InputType.TYPE_CLASS_TEXT | android.text.InputType.TYPE_TEXT_VARIATION_URI);
        input.setHint(R.string.server_hint);
        input.setContentDescription(getString(R.string.server_address));
        input.setText(value);
        input.setSelectAllOnFocus(true);
        return input;
    }

    private void editServer() {
        if (switchingServer || app.serverChange != null || serverDialog != null) return;
        EditText input = serverInput(app.site == null ? "" : app.site.origin);
        LinearLayout form = new LinearLayout(this);
        form.setOrientation(LinearLayout.VERTICAL);
        form.setPadding(dp(24), dp(8), dp(24), 0);
        TextView warning = new TextView(this);
        warning.setText(R.string.server_change_warning);
        form.addView(warning);
        form.addView(input);
        serverDialog = new AlertDialog.Builder(this)
            .setTitle(R.string.server_change)
            .setView(form)
            .setNegativeButton(R.string.cancel, null)
            .setPositiveButton(R.string.server_connect, null)
            .create();
        serverDialog.setOnDismissListener(dialog -> serverDialog = null);
        serverDialog.show();
        serverDialog.getButton(AlertDialog.BUTTON_POSITIVE).setOnClickListener(v -> confirmServer(input));
    }

    private void confirmServer(EditText input) {
        if (confirmDialog != null || app.serverChange != null) return;
        SitePolicy selected = SitePolicy.parseServer(input.getText().toString());
        if (selected == null) {
            input.setError(getString(R.string.server_invalid));
            return;
        }
        confirmDialog = new AlertDialog.Builder(this)
            .setTitle(R.string.server_confirm_title)
            .setMessage(getString(R.string.server_confirm_message, selected.origin))
            .setNegativeButton(R.string.cancel, null)
            .setPositiveButton(R.string.server_connect, (dialog, which) -> changeServer(selected))
            .create();
        AlertDialog confirmation = confirmDialog;
        confirmation.setOnDismissListener(dialog -> { if (confirmDialog == confirmation) confirmDialog = null; });
        confirmation.show();
    }

    private void changeServer(SitePolicy selected) {
        if (switchingServer || app.serverChange != null || isDestroyed()) return;
        // A crash during cleanup must return to a blank native choice screen on the next launch.
        if (!app.servers.save(null)) {
            new AlertDialog.Builder(this).setMessage(R.string.server_save_failed)
                .setPositiveButton(android.R.string.ok, null).show();
            return;
        }
        switchingServer = true;
        document++;
        replyProxy = null;
        cancelPending("session_changed");
        cancelPageRequests();
        if (serverDialog != null) serverDialog.dismiss();
        if (confirmDialog != null) confirmDialog.dismiss();
        if (legacyDialog != null) legacyDialog.dismiss();
        pendingOpenNote = 0;
        pendingOpenOrigin = "";
        legacyOffered = "";
        AsteringApplication.ServerChange transition = app.beginServerChange(selected);
        setScreenAwake(false);
        destroyWeb(true);
        showServerProgress();
        Runnable finishCleanup = () -> runOnUiThread(() -> {
            if (app.serverChange != transition) return;
            CookieManager.getInstance().flush();
            app.completeServerChange(transition, true);
        });
        app.session.afterCookieWrites(() -> {
            if (app.serverChange != transition) return;
            WebViewDatabase.getInstance(getApplicationContext()).clearHttpAuthUsernamePassword();
            if (WebViewFeature.isFeatureSupported(WebViewFeature.DELETE_BROWSING_DATA)) {
                WebStorageCompat.deleteBrowsingData(WebStorage.getInstance(), finishCleanup);
            } else {
                // Cookies are host-scoped, not port-scoped: clear all before a different origin can load.
                WebStorage.getInstance().deleteAllData();
                CookieManager.getInstance().removeAllCookies(removed -> finishCleanup.run());
            }
        }, () -> app.completeServerChange(transition, false));
    }

    private void showServerProgress() {
        root.removeAllViews();
        TextView progress = new TextView(this);
        progress.setPadding(dp(24), dp(32), dp(24), dp(24));
        progress.setText(R.string.server_switching);
        root.addView(progress);
    }

    void serverChangeFinished(int errorResource) {
        switchingServer = false;
        if (isDestroyed() || isFinishing()) return;
        if (app.site == null) showServerForm();
        else showSelectedServer();
        if (errorResource != 0) new AlertDialog.Builder(this).setMessage(errorResource)
            .setPositiveButton(android.R.string.ok, null).show();
        else consumeClientSettings();
    }

    private void showSelectedServer() {
        SitePolicy selected = app.site;
        if (selected == null) { showServerForm(); return; }
        root.removeAllViews();
        rendererGone = false;
        errorPanel = new LinearLayout(this);
        errorPanel.setPadding(dp(20), dp(20), dp(20), dp(20));
        errorPanel.setOrientation(LinearLayout.VERTICAL);
        TextView errorText = new TextView(this);
        errorText.setText(R.string.load_failed);
        errorText.setTextColor(Color.rgb(15, 23, 42));
        errorPanel.addView(errorText);
        Button retry = new Button(this);
        retry.setText(R.string.retry);
        retry.setOnClickListener(v -> {
            if (rendererGone || web == null) { destroyWeb(false); showSelectedServer(); }
            else if (app.site == webSite) web.loadUrl(webSite.origin);
        });
        errorPanel.addView(retry);
        Button settings = new Button(this);
        settings.setText(R.string.server_settings);
        settings.setOnClickListener(v -> showClientSettings());
        errorPanel.addView(settings);
        errorPanel.setVisibility(View.GONE);
        root.addView(errorPanel);
        web = new WebView(this);
        webSite = selected;
        if (!WebViewFeature.isFeatureSupported(WebViewFeature.WEB_MESSAGE_LISTENER)) {
            TextView compatibility = new TextView(this);
            compatibility.setText(R.string.bridge_unavailable);
            compatibility.setPadding(dp(12), dp(8), dp(12), dp(8));
            root.addView(compatibility);
        }
        root.addView(web, new LinearLayout.LayoutParams(-1, 0, 1));
        configureWebView();
        web.loadUrl(noteURL(getIntent()));
    }

    /** Native choices stay here; the website may only request opening this dialog. */
    private boolean showClientSettings() {
        if (!visible || !resumed || isDestroyed() || isFinishing() || switchingServer || app.serverChange != null) return false;
        if (clientSettingsDialog != null) return true;
        if (serverDialog != null || confirmDialog != null || legacyDialog != null || startDialog != null) return false;
        ScrollView scroll = new ScrollView(this);
        LinearLayout content = new LinearLayout(this);
        content.setOrientation(LinearLayout.VERTICAL);
        content.setPadding(dp(24), dp(12), dp(24), dp(8));
        TextView info = new TextView(this);
        String address = app.site == null ? getString(R.string.client_server_none) : app.site.origin;
        info.setText(getString(R.string.client_settings_detail, address, BuildConfig.VERSION_NAME, BuildConfig.VERSION_CODE));
        info.setTextIsSelectable(true);
        content.addView(info);
        TextView help = new TextView(this);
        help.setText(R.string.client_settings_help);
        help.setPadding(0, dp(12), 0, dp(12));
        content.addView(help);
        Button change = new Button(this);
        change.setText(R.string.server_change);
        change.setOnClickListener(view -> { dismissClientSettings(); editServer(); });
        content.addView(change, new LinearLayout.LayoutParams(-1, -2));
        Button updates = new Button(this);
        updates.setText(R.string.update_check);
        updates.setOnClickListener(view -> { dismissClientSettings(); updater.check(true); });
        content.addView(updates, new LinearLayout.LayoutParams(-1, -2));
        Button models = new Button(this);
        models.setText(R.string.models_title);
        models.setOnClickListener(view -> showOfflineModels());
        content.addView(models, new LinearLayout.LayoutParams(-1, -2));
        Button recover = new Button(this);
        recover.setText(R.string.legacy_recover);
        recover.setOnClickListener(view -> { dismissClientSettings(); checkLegacy(true); });
        content.addView(recover, new LinearLayout.LayoutParams(-1, -2));
        scroll.addView(content);
        AlertDialog settings = new AlertDialog.Builder(this)
            .setTitle(R.string.server_settings)
            .setView(scroll)
            .setPositiveButton(R.string.client_settings_close, null)
            .create();
        clientSettingsDialog = settings;
        settings.setOnDismissListener(dialog -> { if (clientSettingsDialog == settings) clientSettingsDialog = null; });
        settings.show();
        return true;
    }

    private void dismissClientSettings() {
        if (modelsDialog != null) { modelsDialog.dismiss(); modelsDialog = null; }
        AlertDialog settings = clientSettingsDialog;
        clientSettingsDialog = null;
        if (settings != null) settings.dismiss();
    }

    private void showOfflineModels() {
        if (!showClientSettings()) return;
        if (modelsDialog == null) modelsDialog = new OfflineModelsDialog(this, app.models);
        modelsDialog.show();
    }

    private void consumeClientSettings() {
        if (pendingClientSettings && showClientSettings()) pendingClientSettings = false;
    }

    private boolean trusted(String url) {
        return !switchingServer && webSite != null && app.site == webSite && webSite.isTrusted(url);
    }

    private static int nextRequestCode() {
        int code = REQUEST_CODES.getAndIncrement();
        if (code > 65535) throw new IllegalStateException("request_limit");
        return code;
    }

    private void cancelPageRequests() {
        microphoneRequest = -1;
        notificationRequest = -1;
        fileRequest = -1;
        fileSite = null;
        fileWeb = null;
        if (browserPermission != null) { browserPermission.deny(); browserPermission = null; }
        if (fileCallback != null) { fileCallback.onReceiveValue(null); fileCallback = null; }
    }

    private void destroyWeb(boolean clearCache) {
        if (web != null) {
            WebView previous = web;
            web = null;
            if (!rendererGone) {
                previous.stopLoading();
                if (clearCache) previous.clearCache(true);
                if (previous.getParent() instanceof android.view.ViewGroup parent) parent.removeView(previous);
                previous.destroy();
            }
        }
        webSite = null;
        rendererGone = false;
    }

    @android.annotation.SuppressLint("SetJavaScriptEnabled")
    private void configureWebView() {
        final WebView configuredWeb = web;
        final SitePolicy selected = webSite;
        WebView.setWebContentsDebuggingEnabled(BuildConfig.DEBUG);
        WebSettings settings = web.getSettings();
        settings.setJavaScriptEnabled(true);
        settings.setDomStorageEnabled(true);
        settings.setAllowFileAccess(false);
        settings.setAllowContentAccess(false);
        settings.setMixedContentMode(WebSettings.MIXED_CONTENT_NEVER_ALLOW);
        settings.setCacheMode(WebSettings.LOAD_DEFAULT);
        settings.setMediaPlaybackRequiresUserGesture(true);
        settings.setSupportMultipleWindows(true);
        CookieManager.getInstance().setAcceptCookie(true);
        CookieManager.getInstance().setAcceptThirdPartyCookies(web, false);
        if (WebViewFeature.isFeatureSupported(WebViewFeature.WEB_MESSAGE_LISTENER)) {
            WebViewCompat.addWebMessageListener(web, "AsteringNative", Collections.singleton(selected.origin),
                (view, message, sourceOrigin, isMainFrame, proxy) -> {
                    if (view != web || web != configuredWeb || app.site != selected || !isMainFrame || !trusted(sourceOrigin.toString())
                        || !trusted(view.getUrl())) return;
                    String raw = message.getData();
                    if (raw == null || raw.length() > 32768) return;
                    replyProxy = proxy;
                    handleCommand(raw, document, proxy);
                });
        }
        web.setWebViewClient(new WebViewClient() {
            @Override public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
                if (view != web || web != configuredWeb || app.site != selected) return true;
                if (!request.isForMainFrame()) return !trusted(request.getUrl().toString());
                String url = request.getUrl().toString();
                if (trusted(url)) return false;
                openExternal(url);
                return true;
            }

            @Override public void onPageStarted(WebView view, String url, android.graphics.Bitmap favicon) {
                if (view != web || web != configuredWeb || app.site != selected) return;
                document++;
                replyProxy = null;
                cancelPending("cancelled");
                cancelPageRequests();
                errorPanel.setVisibility(View.GONE);
                if (!trusted(url)) {
                    view.stopLoading();
                    showLoadError();
                }
            }

            @Override public void onReceivedError(WebView view, WebResourceRequest request, WebResourceError error) {
                if (view == web && request.isForMainFrame()) showLoadError();
            }

            @Override public void onReceivedSslError(WebView view, SslErrorHandler handler, SslError error) {
                handler.cancel();
                if (view == web) showLoadError();
            }

            @Override public boolean onRenderProcessGone(WebView view, android.webkit.RenderProcessGoneDetail detail) {
                if (view != web) { view.destroy(); return true; }
                rendererGone = true;
                replyProxy = null;
                cancelPending("cancelled");
                cancelPageRequests();
                if (app.recorder != null) app.recorder.activityHidden();
                ((android.view.ViewGroup) view.getParent()).removeView(view);
                view.destroy();
                showLoadError();
                return true;
            }
        });
        web.setWebChromeClient(new WebChromeClient() {
            @Override public void onPermissionRequest(PermissionRequest request) {
                runOnUiThread(() -> {
                    if (web != configuredWeb || app.site != selected || !visible || !resumed || !trusted(request.getOrigin().toString())
                        || !trusted(web.getUrl()) || pendingStart != null || app.recorder != null
                        || !Arrays.equals(request.getResources(), new String[]{PermissionRequest.RESOURCE_AUDIO_CAPTURE})) {
                        request.deny();
                        return;
                    }
                    if (browserPermission != null) browserPermission.deny();
                    browserPermission = request;
                    if (checkSelfPermission(Manifest.permission.RECORD_AUDIO) == PackageManager.PERMISSION_GRANTED) {
                        grantBrowserAudio();
                    } else {
                        microphoneRequest = nextRequestCode();
                        requestPermissions(new String[]{Manifest.permission.RECORD_AUDIO}, microphoneRequest);
                    }
                });
            }

            @Override public void onPermissionRequestCanceled(PermissionRequest request) {
                if (browserPermission == request) browserPermission = null;
            }

            @Override public boolean onShowFileChooser(WebView view, ValueCallback<Uri[]> callback,
                FileChooserParams parameters) {
                if (view != web || web != configuredWeb || app.site != selected || !visible || !trusted(view.getUrl())) return false;
                if (fileCallback != null) fileCallback.onReceiveValue(null);
                fileCallback = callback;
                fileDocument = document;
                fileSite = selected;
                fileWeb = configuredWeb;
                Intent intent = new Intent(Intent.ACTION_OPEN_DOCUMENT);
                intent.addCategory(Intent.CATEGORY_OPENABLE);
                intent.setType("*/*");
                intent.putExtra(Intent.EXTRA_ALLOW_MULTIPLE, parameters.getMode() == FileChooserParams.MODE_OPEN_MULTIPLE);
                try {
                    fileRequest = nextRequestCode();
                    startActivityForResult(intent, fileRequest);
                } catch (ActivityNotFoundException | IllegalStateException ignored) {
                    fileRequest = -1;
                    fileCallback = null;
                    callback.onReceiveValue(null);
                }
                return true;
            }

            @Override public boolean onCreateWindow(WebView view, boolean dialog, boolean gesture, android.os.Message result) {
                if (!gesture || view != web || web != configuredWeb || app.site != selected) return false;
                WebView child = new WebView(MainActivity.this);
                child.setWebViewClient(new WebViewClient() {
                    @Override public boolean shouldOverrideUrlLoading(WebView v, WebResourceRequest request) {
                        String url = request.getUrl().toString();
                        if (web == configuredWeb && app.site == selected) {
                            if (trusted(url)) web.loadUrl(url);
                            else openExternal(url);
                        }
                        child.destroy();
                        return true;
                    }

                    @Override public boolean onRenderProcessGone(WebView view, android.webkit.RenderProcessGoneDetail detail) {
                        view.destroy();
                        return true;
                    }
                });
                ((WebView.WebViewTransport) result.obj).setWebView(child);
                result.sendToTarget();
                return true;
            }
        });
    }

    private void handleCommand(String raw, long page, JavaScriptReplyProxy proxy) {
        String id = "";
        try {
            JSONObject command = new JSONObject(raw);
            id = command.getString("id");
            if (id.length() > 80 || id.isEmpty()) return;
            String requestID = id;
            switch (command.getString("action")) {
                case "clientInfo":
                    reply(proxy, page, id, AsteringApplication.object("version_name", BuildConfig.VERSION_NAME,
                        "version_code", BuildConfig.VERSION_CODE, "capabilities", AsteringApplication.object("clientSettings", true)), null);
                    break;
                case "openClientSettings":
                    reply(proxy, page, id, AsteringApplication.object(), showClientSettings() ? null : "foreground_required");
                    break;
                case "session": {
                    app.session.accept(command.getString("token"));
                    SessionFence.Ticket current = app.session.ticket();
                    reply(proxy, page, id, AsteringApplication.object("user_id", current.owner.userID, "sid", current.owner.sid), null);
                    consumeOpenNote();
                    break;
                }
                case "clearSession":
                    cancelPending("session_changed");
                    cancelPageRequests();
                    app.session.clear();
                    reply(proxy, page, id, AsteringApplication.object(), null);
                    break;
                case "refresh":
                    app.session.refresh(command.optString("token"), true, (token, error) ->
                        reply(proxy, page, requestID, AsteringApplication.object("token", token), error));
                    break;
                case "offlineStatus":
                    app.offline.status((result, error) -> reply(proxy, page, requestID, result, error));
                    break;
                case "listOffline":
                    app.offline.list(command.optLong("note_id", 0), command.optInt("offset", 0), command.optInt("limit", 20), command.optString("cursor"),
                        (result, error) -> reply(proxy, page, requestID, result, error));
                    break;
                case "syncOffline":
                    app.session.ensureVerified();
                    app.offline.kick(true);
                    app.offline.status((result, error) -> reply(proxy, page, requestID, result, error));
                    break;
                case "clearOffline":
                    if (!command.optBoolean("confirm")) reply(proxy, page, id, null, "confirmation_required");
                    else app.offline.clear((result, error) -> reply(proxy, page, requestID, result, error));
                    break;
                case "recordingStatus":
                    reply(proxy, page, id, app.snapshot(), null);
                    break;
                case "startRecording":
                    requestRecording(command, page, proxy, id);
                    break;
                case "stopRecording": {
                    SessionFence.Ticket owner = app.session.ticket();
                    long noteID = command.optLong("note_id");
                    if (owner == null || !owner.owner.sid.equals(command.optString("sid"))) {
                        reply(proxy, page, id, null, "session_changed");
                        break;
                    }
                    if (pendingStart != null && pendingStart.noteID == noteID) cancelPending("cancelled");
                    RecordingLease approved = app.approvedRecording;
                    boolean cancelledLaunch = approved != null && approved.matches(owner, noteID);
                    if (cancelledLaunch) app.approvedRecording = null;
                    RecordingService recorder = app.recorder;
                    if (recorder != null && !recorder.matches(owner, noteID) && !cancelledLaunch) {
                        reply(proxy, page, id, null, "already_recording");
                        break;
                    }
                    if (recorder != null && !cancelledLaunch) recorder.stopFromPage();
                    else app.publishIdle(noteID);
                    reply(proxy, page, id, app.snapshot(), null);
                    break;
                }
                default:
                    reply(proxy, page, id, null, "unsupported");
            }
        } catch (Exception ignored) {
            reply(proxy, page, id, null, "invalid_request");
        }
    }

    private void requestRecording(JSONObject command, long page, JavaScriptReplyProxy proxy, String id) throws Exception {
        if (!visible || !resumed || !hasWindowFocus() || clientSettingsDialog != null) {
            reply(proxy, page, id, null, "foreground_required");
            return;
        }
        SessionFence.Ticket owner = app.session.ticket();
        SessionIdentity supplied = SessionIdentity.parse(command.optString("token"));
        long noteID = command.getLong("note_id");
        int sampleRate = command.getInt("sample_rate");
        String connection = command.optString("connection_id");
        String language = command.optString("language");
        String engine = command.optString("engine", "online");
        String defaultTimezone = java.time.ZoneId.systemDefault().getId();
        if (!java.time.ZoneId.getAvailableZoneIds().contains(defaultTimezone)) defaultTimezone = "UTC";
        String timezone = command.optString("timezone", defaultTimezone);
        long startOffset = command.optLong("start_offset_ms", 0);
        if (!java.time.ZoneId.getAvailableZoneIds().contains(timezone) && !timezone.equals("UTC"))
            throw new IllegalArgumentException("invalid_timezone");
        if (owner == null || !owner.owner.sameOwner(supplied) || engine.equals("local") && !app.session.verified(owner)) {
            reply(proxy, page, id, null, "authentication");
            return;
        }
        if (noteID <= 0 || (sampleRate != 16000 && sampleRate != 24000) || connection.length() > 80 || language.length() > 40
            || (!engine.equals("online") && !engine.equals("local")) || engine.equals("local") && sampleRate != 16000
            || startOffset < 0 || startOffset > 315360000000L || timezone.length() > 100) {
            reply(proxy, page, id, null, "invalid_request");
            return;
        }
        if (pendingStart != null || app.recorder != null || browserPermission != null) {
            reply(proxy, page, id, null, "already_recording");
            return;
        }
        if (engine.equals("local") && !app.models.hasSelected()) {
            reply(proxy, page, id, null, "cancelled");
            showOfflineModels();
            return;
        }
        pendingStart = new PendingStart(id, page, proxy, owner, noteID, sampleRate, connection, language,
            command.optBoolean("allow_background"), command.optBoolean("keep_awake"), engine, timezone,
            startOffset, command.optBoolean("append_to_article"));
        startDialog = new AlertDialog.Builder(this)
            .setTitle(R.string.recording_start)
            .setMessage(pendingStart.engine.equals("local") ? R.string.recording_local
                : pendingStart.background ? R.string.recording_background : R.string.recording_foreground)
            .setNegativeButton(R.string.cancel, (dialog, which) -> cancelPending("cancelled"))
            .setPositiveButton(R.string.start, (dialog, which) -> continueStart())
            .setOnCancelListener(dialog -> cancelPending("cancelled"))
            .create();
        startDialog.show();
    }

    private void continueStart() {
        PendingStart request = pendingStart;
        if (request == null) return;
        if (!visible || !app.session.current(request.owner) || request.page != document) {
            cancelPending("cancelled");
            return;
        }
        if (checkSelfPermission(Manifest.permission.RECORD_AUDIO) != PackageManager.PERMISSION_GRANTED) {
            microphoneRequest = nextRequestCode();
            requestPermissions(new String[]{Manifest.permission.RECORD_AUDIO}, microphoneRequest);
            return;
        }
        if (Build.VERSION.SDK_INT >= 33
            && checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED) {
            notificationRequest = nextRequestCode();
            requestPermissions(new String[]{Manifest.permission.POST_NOTIFICATIONS}, notificationRequest);
            return;
        }
        pendingStart = null;
        Intent intent = new Intent(this, RecordingService.class);
        intent.setAction(RecordingService.START);
        String generation = UUID.randomUUID().toString();
        intent.putExtra("generation", generation);
        intent.putExtra("epoch", request.owner.epoch);
        intent.putExtra("server_origin", request.owner.origin);
        intent.putExtra("user_id", request.owner.owner.userID);
        intent.putExtra("sid", request.owner.owner.sid);
        intent.putExtra("note_id", request.noteID);
        intent.putExtra("sample_rate", request.sampleRate);
        intent.putExtra("connection_id", request.connection);
        intent.putExtra("language", request.language);
        intent.putExtra("allow_background", request.background);
        intent.putExtra("keep_awake", request.keepAwake);
        intent.putExtra("engine", request.engine);
        intent.putExtra("timezone", request.timezone);
        intent.putExtra("start_offset_ms", request.startOffset);
        intent.putExtra("append_to_article", request.appendToArticle);
        app.approvedRecording = new RecordingLease(request.owner, request.noteID, generation);
        try {
            startForegroundService(intent);
            reply(request.proxy, request.page, request.id,
                AsteringApplication.object("state", "connecting", "user_id", request.owner.owner.userID,
                    "sid", request.owner.owner.sid, "note_id", request.noteID, "allow_background", request.background,
                    "server_origin", request.owner.origin, "session_epoch", request.owner.epoch, "engine", request.engine,
                    "sequence", app.snapshot().optLong("sequence")), null);
        } catch (RuntimeException ignored) {
            app.approvedRecording = null;
            reply(request.proxy, request.page, request.id, null, "foreground_required");
        }
    }

    private void cancelPending(String error) {
        PendingStart pending = pendingStart;
        pendingStart = null;
        if (startDialog != null) {
            startDialog.dismiss();
            startDialog = null;
        }
        if (pending != null) reply(pending.proxy, pending.page, pending.id, null, error);
    }

    @Override public void onRequestPermissionsResult(int code, String[] permissions, int[] results) {
        super.onRequestPermissionsResult(code, permissions, results);
        boolean granted = results.length > 0 && results[0] == PackageManager.PERMISSION_GRANTED;
        if (code == microphoneRequest) {
            microphoneRequest = -1;
            if (browserPermission != null) {
                if (granted) grantBrowserAudio();
                else { browserPermission.deny(); browserPermission = null; }
            } else if (granted) continueStart();
            else cancelPending("permission");
        } else if (code == notificationRequest) {
            notificationRequest = -1;
            if (granted) continueStart();
            else cancelPending("notification_permission");
        }
    }

    private void grantBrowserAudio() {
        PermissionRequest pending = browserPermission;
        browserPermission = null;
        if (pending == null) return;
        if (visible && web != null && trusted(web.getUrl()) && app.recorder == null) {
            pending.grant(new String[]{PermissionRequest.RESOURCE_AUDIO_CAPTURE});
        } else pending.deny();
    }

    @Override protected void onActivityResult(int code, int result, Intent data) {
        super.onActivityResult(code, result, data);
        if (code != fileRequest || fileCallback == null) return;
        fileRequest = -1;
        ValueCallback<Uri[]> pending = fileCallback;
        fileCallback = null;
        if (result != RESULT_OK || data == null || web == null || web != fileWeb || webSite != fileSite
            || document != fileDocument || !trusted(web.getUrl())) {
            pending.onReceiveValue(null);
            return;
        }
        if (data.getClipData() != null) {
            int count = Math.min(100, data.getClipData().getItemCount());
            Uri[] items = new Uri[count];
            for (int i = 0; i < count; i++) {
                items[i] = data.getClipData().getItemAt(i).getUri();
                if (!readableDocument(items[i])) {
                    pending.onReceiveValue(null);
                    return;
                }
            }
            pending.onReceiveValue(items);
        } else pending.onReceiveValue(readableDocument(data.getData()) ? new Uri[]{data.getData()} : null);
    }

    private void checkLegacy(boolean explicit) {
        SessionFence.Ticket owner = app.session.ticket();
        if (switchingServer || !resumed || isDestroyed()) return;
        if (owner == null || !app.session.verified(owner) || !SitePolicy.LEGACY_OUTBOX_ORIGIN.equals(owner.origin)) {
            if (explicit) new AlertDialog.Builder(this).setMessage(R.string.legacy_unavailable)
                .setPositiveButton(android.R.string.ok, null).show();
            return;
        }
        app.offline.status((status, error) -> {
            if (!app.session.current(owner) || isDestroyed() || !resumed) return;
            if (error != null || status == null) {
                if (explicit) new AlertDialog.Builder(this).setMessage(R.string.legacy_failed)
                    .setPositiveButton(android.R.string.ok, null).show();
                return;
            }
            offerLegacy(owner, status, explicit);
        });
    }

    private void offerLegacy(SessionFence.Ticket owner, JSONObject status, boolean explicit) {
        if (owner == null || !app.session.verified(owner) || !owner.origin.equals(status.optString("server_origin"))
            || switchingServer || !resumed || isDestroyed() || clientSettingsDialog != null
            || legacyDialog != null || serverDialog != null || startDialog != null) return;
        int count = status.optInt("legacy_pending_count");
        if (count == 0) {
            if (explicit) new AlertDialog.Builder(this).setMessage(R.string.legacy_empty)
                .setPositiveButton(android.R.string.ok, null).show();
            return;
        }
        if (app.recorder != null) {
            if (explicit) new AlertDialog.Builder(this).setMessage(R.string.legacy_stop_first)
                .setPositiveButton(android.R.string.ok, null).show();
            return;
        }
        String key = owner.origin + "/" + owner.owner.userID + "/" + owner.epoch;
        if (!explicit && key.equals(legacyOffered)) return;
        legacyOffered = key;
        legacyDialog = new AlertDialog.Builder(this)
            .setTitle(R.string.legacy_recover)
            .setMessage(getString(R.string.legacy_message, count, owner.origin))
            .setNegativeButton(R.string.legacy_later, null)
            .setPositiveButton(R.string.legacy_confirm, (dialog, which) -> {
                if (!app.session.current(owner) || !app.session.verified(owner)) return;
                AlertDialog progress = new AlertDialog.Builder(this).setMessage(R.string.legacy_working)
                    .setCancelable(false).create();
                legacyDialog = progress;
                progress.show();
                app.offline.migrateLegacy(owner, (result, error) -> {
                    progress.dismiss();
                    if (legacyDialog == progress) legacyDialog = null;
                    if (!app.session.current(owner) || isDestroyed()) return;
                    new AlertDialog.Builder(this).setMessage(error == null ? R.string.legacy_done : R.string.legacy_failed)
                        .setPositiveButton(android.R.string.ok, null).show();
                });
            })
            .create();
        AlertDialog offered = legacyDialog;
        offered.setOnDismissListener(dialog -> { if (legacyDialog == offered) legacyDialog = null; });
        offered.show();
    }

    void emit(JSONObject event) {
        if (event.optString("event").equals("offline")) {
            JSONObject status = event.optJSONObject("status");
            if (status != null) offerLegacy(app.session.ticket(), status, false);
        }
        if (web == null || rendererGone || replyProxy == null || !WebViewFeature.isFeatureSupported(WebViewFeature.WEB_MESSAGE_LISTENER)
            || !trusted(web.getUrl())) return;
        try {
            replyProxy.postMessage(event.toString());
        } catch (RuntimeException ignored) {
            replyProxy = null;
        }
    }

    private void reply(JavaScriptReplyProxy proxy, long page, String id, JSONObject result, String error) {
        if (web == null || rendererGone || page != document || isDestroyed()
            || !WebViewFeature.isFeatureSupported(WebViewFeature.WEB_MESSAGE_LISTENER) || !trusted(web.getUrl())) return;
        try {
            proxy.postMessage(error == null
                ? AsteringApplication.object("id", id, "ok", true, "result", result).toString()
                : AsteringApplication.object("id", id, "ok", false, "error", error).toString());
        } catch (RuntimeException ignored) {
            // A reply to a detached document has no recipient.
        }
    }

    private void showLoadError() {
        if (errorPanel != null) errorPanel.setVisibility(View.VISIBLE);
    }

    private void openExternal(String url) {
        if (!SitePolicy.isExternalWeb(url)) return;
        try {
            startActivity(new Intent(Intent.ACTION_VIEW, Uri.parse(url)));
        } catch (ActivityNotFoundException ignored) {
            showLoadError();
        }
    }

    private String noteURL(Intent intent) {
        if (CLIENT_SETTINGS_ACTION.equals(intent.getAction())) return app.site.origin;
        long note = intent.getLongExtra("note_id", 0);
        SessionFence.Ticket owner = app.session.ticket();
        boolean same = owner != null && owner.owner.userID == intent.getLongExtra("user_id", 0)
            && owner.owner.sid.equals(intent.getStringExtra("sid"))
            && owner.origin.equals(intent.getStringExtra("server_origin"));
        return app.site.origin + (note > 0 && same ? "/notes/" + note : "");
    }

    @Override protected void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        if (CLIENT_SETTINGS_ACTION.equals(intent.getAction())) {
            pendingClientSettings = true;
            consumeClientSettings();
            return;
        }
        setIntent(intent);
        rememberOpenNote(intent);
        consumeOpenNote();
    }

    private void rememberOpenNote(Intent intent) {
        pendingOpenNote = intent.getLongExtra("note_id", 0);
        pendingOpenUser = intent.getLongExtra("user_id", 0);
        pendingOpenSid = intent.getStringExtra("sid");
        pendingOpenOrigin = intent.getStringExtra("server_origin");
    }

    private void consumeOpenNote() {
        SessionFence.Ticket owner = app.session.ticket();
        if (owner == null || replyProxy == null || pendingOpenNote <= 0) return;
        if (owner.owner.userID == pendingOpenUser && owner.owner.sid.equals(pendingOpenSid)
            && owner.origin.equals(pendingOpenOrigin)) {
            emit(AsteringApplication.object("event", "openNote", "note_id", pendingOpenNote,
                "user_id", owner.owner.userID, "sid", owner.owner.sid, "server_origin", owner.origin));
        }
        pendingOpenNote = 0;
        pendingOpenSid = "";
        pendingOpenOrigin = "";
    }

    boolean isVisible() {
        return visible;
    }

    boolean isRecordingStartAllowed() {
        return visible && resumed && web != null && trusted(web.getUrl());
    }

    private boolean readableDocument(Uri uri) {
        if (uri == null || !"content".equals(uri.getScheme()) || uri.getAuthority() == null
            || uri.getAuthority().startsWith(getPackageName())) return false;
        return checkUriPermission(uri, android.os.Process.myPid(), android.os.Process.myUid(),
            Intent.FLAG_GRANT_READ_URI_PERMISSION) == PackageManager.PERMISSION_GRANTED;
    }

    @Override protected void onStart() {
        super.onStart();
        visible = true;
        app.attach(this);
    }

    @Override protected void onResume() {
        super.onResume();
        resumed = true;
        if (web != null && !rendererGone) web.onResume();
        updater.check(false);
        checkLegacy(false);
        JSONObject snapshot = app.snapshot();
        setScreenAwake(snapshot.optBoolean("keep_awake") && AsteringApplication.active(snapshot.optString("state")));
        emit(AsteringApplication.object("event", "recording", "snapshot", snapshot));
        consumeClientSettings();
    }

    @Override protected void onPause() {
        resumed = false;
        dismissClientSettings();
        super.onPause();
    }

    @Override protected void onStop() {
        visible = false;
        cancelPending("cancelled");
        RecordingLease approved = app.approvedRecording;
        if (approved != null) {
            app.approvedRecording = null;
            app.publishIdle(approved.noteID);
        }
        if (browserPermission != null) {
            browserPermission.deny();
            browserPermission = null;
        }
        if (!isChangingConfigurations() && app.recorder != null) app.recorder.activityHidden();
        if (web != null && !rendererGone) web.onPause();
        setScreenAwake(false);
        super.onStop();
    }

    void setScreenAwake(boolean awake) {
        if (awake && visible) getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
        else getWindow().clearFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
    }

    @Override public boolean onKeyUp(int keyCode, android.view.KeyEvent event) {
        if (Build.VERSION.SDK_INT < 33 && keyCode == android.view.KeyEvent.KEYCODE_BACK
            && !event.isCanceled() && web != null && !rendererGone && web.canGoBack()) {
            web.goBack();
            return true;
        }
        return super.onKeyUp(keyCode, event);
    }

    @Override protected void onSaveInstanceState(Bundle outState) {
        outState.putBoolean("open_client_settings", pendingClientSettings);
        super.onSaveInstanceState(outState);
    }

    @Override protected void onDestroy() {
        dismissClientSettings();
        cancelPending("cancelled");
        cancelPageRequests();
        if (serverDialog != null) serverDialog.dismiss();
        if (confirmDialog != null) confirmDialog.dismiss();
        if (legacyDialog != null) legacyDialog.dismiss();
        updater.close();
        app.detach(this);
        replyProxy = null;
        destroyWeb(false);
        super.onDestroy();
    }

    private static final class PendingStart {
        final String id;
        final long page;
        final JavaScriptReplyProxy proxy;
        final SessionFence.Ticket owner;
        final long noteID;
        final int sampleRate;
        final String connection;
        final String language;
        final boolean background;
        final boolean keepAwake;
        final String engine;
        final String timezone;
        final long startOffset;
        final boolean appendToArticle;

        PendingStart(String id, long page, JavaScriptReplyProxy proxy, SessionFence.Ticket owner,
            long noteID, int sampleRate, String connection, String language, boolean background, boolean keepAwake,
            String engine, String timezone, long startOffset, boolean appendToArticle) {
            this.id = id;
            this.page = page;
            this.proxy = proxy;
            this.owner = owner;
            this.noteID = noteID;
            this.sampleRate = sampleRate;
            this.connection = connection;
            this.language = language;
            this.background = background;
            this.keepAwake = keepAwake;
            this.engine = engine;
            this.timezone = timezone;
            this.startOffset = startOffset;
            this.appendToArticle = appendToArticle;
        }
    }
}
