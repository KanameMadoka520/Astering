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
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.Button;
import android.widget.LinearLayout;
import android.widget.TextView;
import androidx.webkit.JavaScriptReplyProxy;
import androidx.webkit.WebViewCompat;
import androidx.webkit.WebViewFeature;
import java.util.Arrays;
import java.util.Collections;
import java.util.UUID;
import org.json.JSONObject;

public final class MainActivity extends Activity {
    private static final int MICROPHONE_REQUEST = 41;
    private static final int NOTIFICATION_REQUEST = 42;
    private static final int FILE_REQUEST = 43;
    private AsteringApplication app;
    private WebView web;
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

    @Override public void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        app = (AsteringApplication) getApplication();
        app.attach(this);
        rememberOpenNote(getIntent());
        LinearLayout root = new LinearLayout(this);
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
        errorPanel = new LinearLayout(this);
        errorPanel.setPadding(32, 32, 32, 32);
        errorPanel.setOrientation(LinearLayout.VERTICAL);
        TextView errorText = new TextView(this);
        errorText.setText(R.string.load_failed);
        errorText.setTextColor(Color.rgb(15, 23, 42));
        errorPanel.addView(errorText);
        Button retry = new Button(this);
        retry.setText(R.string.retry);
        retry.setOnClickListener(v -> {
            if (rendererGone) recreate();
            else web.loadUrl(SitePolicy.ORIGIN);
        });
        errorPanel.addView(retry);
        errorPanel.setVisibility(View.GONE);
        root.addView(errorPanel);
        web = new WebView(this);
        if (!WebViewFeature.isFeatureSupported(WebViewFeature.WEB_MESSAGE_LISTENER)) {
            TextView compatibility = new TextView(this);
            compatibility.setText(R.string.bridge_unavailable);
            compatibility.setPadding(16, 12, 16, 12);
            root.addView(compatibility);
        }
        root.addView(web, new LinearLayout.LayoutParams(-1, 0, 1));
        setContentView(root);
        configureWebView();
        if (Build.VERSION.SDK_INT >= 33) {
            getOnBackInvokedDispatcher().registerOnBackInvokedCallback(android.window.OnBackInvokedDispatcher.PRIORITY_DEFAULT,
                () -> {
                    if (!rendererGone && web.canGoBack()) web.goBack();
                    else finish();
                });
        }
        String initial = noteURL(getIntent());
        web.loadUrl(initial);
    }

    @android.annotation.SuppressLint("SetJavaScriptEnabled")
    private void configureWebView() {
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
            WebViewCompat.addWebMessageListener(web, "AsteringNative", Collections.singleton(SitePolicy.ORIGIN),
                (view, message, sourceOrigin, isMainFrame, proxy) -> {
                    if (!isMainFrame || !SitePolicy.isTrusted(sourceOrigin.toString())
                        || !SitePolicy.isTrusted(view.getUrl())) return;
                    String raw = message.getData();
                    if (raw == null || raw.length() > 32768) return;
                    replyProxy = proxy;
                    handleCommand(raw, document, proxy);
                });
        }
        web.setWebViewClient(new WebViewClient() {
            @Override public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
                if (!request.isForMainFrame()) return !SitePolicy.isTrusted(request.getUrl().toString());
                String url = request.getUrl().toString();
                if (SitePolicy.isTrusted(url)) return false;
                openExternal(url);
                return true;
            }

            @Override public void onPageStarted(WebView view, String url, android.graphics.Bitmap favicon) {
                document++;
                replyProxy = null;
                cancelPending("cancelled");
                errorPanel.setVisibility(View.GONE);
                if (!SitePolicy.isTrusted(url)) {
                    view.stopLoading();
                    showLoadError();
                }
            }

            @Override public void onReceivedError(WebView view, WebResourceRequest request, WebResourceError error) {
                if (request.isForMainFrame()) showLoadError();
            }

            @Override public void onReceivedSslError(WebView view, SslErrorHandler handler, SslError error) {
                handler.cancel();
                showLoadError();
            }

            @Override public boolean onRenderProcessGone(WebView view, android.webkit.RenderProcessGoneDetail detail) {
                rendererGone = true;
                replyProxy = null;
                cancelPending("cancelled");
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
                    if (!visible || !resumed || !SitePolicy.isTrusted(request.getOrigin().toString())
                        || !SitePolicy.isTrusted(web.getUrl()) || pendingStart != null || app.recorder != null
                        || !Arrays.equals(request.getResources(), new String[]{PermissionRequest.RESOURCE_AUDIO_CAPTURE})) {
                        request.deny();
                        return;
                    }
                    if (browserPermission != null) browserPermission.deny();
                    browserPermission = request;
                    if (checkSelfPermission(Manifest.permission.RECORD_AUDIO) == PackageManager.PERMISSION_GRANTED) {
                        grantBrowserAudio();
                    } else {
                        requestPermissions(new String[]{Manifest.permission.RECORD_AUDIO}, MICROPHONE_REQUEST);
                    }
                });
            }

            @Override public void onPermissionRequestCanceled(PermissionRequest request) {
                if (browserPermission == request) browserPermission = null;
            }

            @Override public boolean onShowFileChooser(WebView view, ValueCallback<Uri[]> callback,
                FileChooserParams parameters) {
                if (!visible || !SitePolicy.isTrusted(view.getUrl())) return false;
                if (fileCallback != null) fileCallback.onReceiveValue(null);
                fileCallback = callback;
                Intent intent = new Intent(Intent.ACTION_OPEN_DOCUMENT);
                intent.addCategory(Intent.CATEGORY_OPENABLE);
                intent.setType("*/*");
                intent.putExtra(Intent.EXTRA_ALLOW_MULTIPLE, parameters.getMode() == FileChooserParams.MODE_OPEN_MULTIPLE);
                try {
                    startActivityForResult(intent, FILE_REQUEST);
                } catch (ActivityNotFoundException ignored) {
                    fileCallback = null;
                    callback.onReceiveValue(null);
                }
                return true;
            }

            @Override public boolean onCreateWindow(WebView view, boolean dialog, boolean gesture, android.os.Message result) {
                if (!gesture) return false;
                WebView child = new WebView(MainActivity.this);
                child.setWebViewClient(new WebViewClient() {
                    @Override public boolean shouldOverrideUrlLoading(WebView v, WebResourceRequest request) {
                        String url = request.getUrl().toString();
                        if (SitePolicy.isTrusted(url)) web.loadUrl(url);
                        else openExternal(url);
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
                case "session": {
                    app.session.accept(command.getString("token"));
                    SessionFence.Ticket current = app.session.ticket();
                    reply(proxy, page, id, AsteringApplication.object("user_id", current.owner.userID, "sid", current.owner.sid), null);
                    consumeOpenNote();
                    break;
                }
                case "clearSession":
                    cancelPending("session_changed");
                    app.session.clear();
                    reply(proxy, page, id, AsteringApplication.object(), null);
                    break;
                case "refresh":
                    app.session.refresh(command.optString("token"), true, (token, error) ->
                        reply(proxy, page, requestID, AsteringApplication.object("token", token), error));
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
        if (!visible || !resumed || !hasWindowFocus()) {
            reply(proxy, page, id, null, "foreground_required");
            return;
        }
        SessionFence.Ticket owner = app.session.ticket();
        SessionIdentity supplied = SessionIdentity.parse(command.optString("token"));
        long noteID = command.getLong("note_id");
        int sampleRate = command.getInt("sample_rate");
        String connection = command.optString("connection_id");
        String language = command.optString("language");
        if (owner == null || !owner.owner.sameOwner(supplied)) {
            reply(proxy, page, id, null, "authentication");
            return;
        }
        if (noteID <= 0 || (sampleRate != 16000 && sampleRate != 24000) || connection.length() > 80 || language.length() > 40) {
            reply(proxy, page, id, null, "invalid_request");
            return;
        }
        if (pendingStart != null || app.recorder != null || browserPermission != null) {
            reply(proxy, page, id, null, "already_recording");
            return;
        }
        pendingStart = new PendingStart(id, page, proxy, owner, noteID, sampleRate, connection, language,
            command.optBoolean("allow_background"), command.optBoolean("keep_awake"));
        startDialog = new AlertDialog.Builder(this)
            .setTitle(R.string.recording_start)
            .setMessage(pendingStart.background ? R.string.recording_background : R.string.recording_foreground)
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
            requestPermissions(new String[]{Manifest.permission.RECORD_AUDIO}, MICROPHONE_REQUEST);
            return;
        }
        if (Build.VERSION.SDK_INT >= 33
            && checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED) {
            requestPermissions(new String[]{Manifest.permission.POST_NOTIFICATIONS}, NOTIFICATION_REQUEST);
            return;
        }
        pendingStart = null;
        Intent intent = new Intent(this, RecordingService.class);
        intent.setAction(RecordingService.START);
        String generation = UUID.randomUUID().toString();
        intent.putExtra("generation", generation);
        intent.putExtra("epoch", request.owner.epoch);
        intent.putExtra("user_id", request.owner.owner.userID);
        intent.putExtra("sid", request.owner.owner.sid);
        intent.putExtra("note_id", request.noteID);
        intent.putExtra("sample_rate", request.sampleRate);
        intent.putExtra("connection_id", request.connection);
        intent.putExtra("language", request.language);
        intent.putExtra("allow_background", request.background);
        intent.putExtra("keep_awake", request.keepAwake);
        app.approvedRecording = new RecordingLease(request.owner, request.noteID, generation);
        try {
            startForegroundService(intent);
            reply(request.proxy, request.page, request.id,
                AsteringApplication.object("state", "connecting", "user_id", request.owner.owner.userID,
                    "sid", request.owner.owner.sid, "note_id", request.noteID, "allow_background", request.background,
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
        if (code == MICROPHONE_REQUEST && browserPermission != null) {
            if (granted) grantBrowserAudio();
            else {
                browserPermission.deny();
                browserPermission = null;
            }
        } else if (code == MICROPHONE_REQUEST || code == NOTIFICATION_REQUEST) {
            if (granted) continueStart();
            else cancelPending(code == NOTIFICATION_REQUEST ? "notification_permission" : "permission");
        }
    }

    private void grantBrowserAudio() {
        PermissionRequest pending = browserPermission;
        browserPermission = null;
        if (pending == null) return;
        if (visible && SitePolicy.isTrusted(web.getUrl()) && app.recorder == null) {
            pending.grant(new String[]{PermissionRequest.RESOURCE_AUDIO_CAPTURE});
        } else pending.deny();
    }

    @Override protected void onActivityResult(int code, int result, Intent data) {
        super.onActivityResult(code, result, data);
        if (code != FILE_REQUEST || fileCallback == null) return;
        ValueCallback<Uri[]> pending = fileCallback;
        fileCallback = null;
        if (result != RESULT_OK || data == null || !SitePolicy.isTrusted(web.getUrl())) {
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

    void emit(JSONObject event) {
        if (rendererGone || replyProxy == null || !WebViewFeature.isFeatureSupported(WebViewFeature.WEB_MESSAGE_LISTENER)
            || !SitePolicy.isTrusted(web.getUrl())) return;
        try {
            replyProxy.postMessage(event.toString());
        } catch (RuntimeException ignored) {
            replyProxy = null;
        }
    }

    private void reply(JavaScriptReplyProxy proxy, long page, String id, JSONObject result, String error) {
        if (rendererGone || page != document || isDestroyed()
            || !WebViewFeature.isFeatureSupported(WebViewFeature.WEB_MESSAGE_LISTENER) || !SitePolicy.isTrusted(web.getUrl())) return;
        try {
            proxy.postMessage(error == null
                ? AsteringApplication.object("id", id, "ok", true, "result", result).toString()
                : AsteringApplication.object("id", id, "ok", false, "error", error).toString());
        } catch (RuntimeException ignored) {
            // A reply to a detached document has no recipient.
        }
    }

    private void showLoadError() {
        errorPanel.setVisibility(View.VISIBLE);
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
        long note = intent.getLongExtra("note_id", 0);
        SessionFence.Ticket owner = app.session.ticket();
        boolean same = owner != null && owner.owner.userID == intent.getLongExtra("user_id", 0)
            && owner.owner.sid.equals(intent.getStringExtra("sid"));
        return SitePolicy.ORIGIN + (note > 0 && same ? "/notes/" + note : "");
    }

    @Override protected void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        setIntent(intent);
        rememberOpenNote(intent);
        consumeOpenNote();
    }

    private void rememberOpenNote(Intent intent) {
        pendingOpenNote = intent.getLongExtra("note_id", 0);
        pendingOpenUser = intent.getLongExtra("user_id", 0);
        pendingOpenSid = intent.getStringExtra("sid");
    }

    private void consumeOpenNote() {
        SessionFence.Ticket owner = app.session.ticket();
        if (owner == null || replyProxy == null || pendingOpenNote <= 0) return;
        if (owner.owner.userID == pendingOpenUser && owner.owner.sid.equals(pendingOpenSid)) {
            emit(AsteringApplication.object("event", "openNote", "note_id", pendingOpenNote,
                "user_id", owner.owner.userID, "sid", owner.owner.sid));
        }
        pendingOpenNote = 0;
        pendingOpenSid = "";
    }

    boolean isVisible() {
        return visible;
    }

    boolean isRecordingStartAllowed() {
        return visible && resumed;
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
        if (!rendererGone) web.onResume();
        JSONObject snapshot = app.snapshot();
        setScreenAwake(snapshot.optBoolean("keep_awake") && AsteringApplication.active(snapshot.optString("state")));
        emit(AsteringApplication.object("event", "recording", "snapshot", snapshot));
    }

    @Override protected void onPause() {
        resumed = false;
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
        if (!rendererGone) web.onPause();
        setScreenAwake(false);
        super.onStop();
    }

    void setScreenAwake(boolean awake) {
        if (awake && visible) getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
        else getWindow().clearFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
    }

    @Override public boolean onKeyUp(int keyCode, android.view.KeyEvent event) {
        if (Build.VERSION.SDK_INT < 33 && keyCode == android.view.KeyEvent.KEYCODE_BACK
            && !event.isCanceled() && !rendererGone && web.canGoBack()) {
            web.goBack();
            return true;
        }
        return super.onKeyUp(keyCode, event);
    }

    @Override protected void onDestroy() {
        cancelPending("cancelled");
        if (fileCallback != null) fileCallback.onReceiveValue(null);
        app.detach(this);
        replyProxy = null;
        if (!rendererGone) web.destroy();
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

        PendingStart(String id, long page, JavaScriptReplyProxy proxy, SessionFence.Ticket owner,
            long noteID, int sampleRate, String connection, String language, boolean background, boolean keepAwake) {
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
        }
    }
}
