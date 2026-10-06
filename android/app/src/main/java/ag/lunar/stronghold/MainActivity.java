package ag.lunar.stronghold;

import android.app.Activity;
import android.app.AlertDialog;
import android.content.ActivityNotFoundException;
import android.content.Intent;
import android.content.SharedPreferences;
import android.content.pm.ApplicationInfo;
import android.content.pm.PackageManager;
import android.graphics.Color;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.text.InputType;
import android.view.DisplayCutout;
import android.view.View;
import android.view.WindowInsets;
import android.view.WindowInsetsController;
import android.view.WindowManager;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceError;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.EditText;
import android.widget.FrameLayout;

/**
 * The app (docs/ANDROID.md): the chosen game server's page in a full-screen, landscape WebView — no address or tab bar,
 * the screen kept on — with the game's resources answered from the APK (BundledAssets). The game's code always comes
 * from the server, so the app plays whatever version the server runs; the server is chosen at the first start and
 * from the menu of the Back button (切换服务器), 晴猫's site by default.
 */
public class MainActivity extends Activity {
    /** The servers offered by default: [label, origin]. The first is the default. */
    private static final String[][] SERVERS = {
        { "晴猫的服务器（stronghold.lunar.ag）", "https://stronghold.lunar.ag" },
        { "卫.slapq.top", "https://xn--rlr.slapq.top" },
    };
    private static final String PREF_SERVER = "server";
    /** Marks the WebView's user agent: the client skips its own resource download (public/js/appShell.js). */
    private static final String UA_TOKEN = "StrongholdApp";

    private WebView web;
    private BundledAssets bundled;
    private SharedPreferences prefs;
    private String server;
    private AlertDialog dialog;

    @Override
    protected void onCreate(Bundle state) {
        super.onCreate(state);
        getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
        prefs = getSharedPreferences("stronghold", MODE_PRIVATE);
        bundled = new BundledAssets(getAssets());

        if ((getApplicationInfo().flags & ApplicationInfo.FLAG_DEBUGGABLE) != 0) WebView.setWebContentsDebuggingEnabled(true);
        web = new WebView(this);
        web.setBackgroundColor(Color.rgb(0x0c, 0x0f, 0x0e));
        WebSettings s = web.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);
        s.setDatabaseEnabled(true);
        s.setMediaPlaybackRequiresUserGesture(false);
        s.setTextZoom(100);                 // the system font size must not re-scale a layout made for the screen
        s.setSupportZoom(false);
        s.setBuiltInZoomControls(false);
        s.setDisplayZoomControls(false);
        s.setLoadWithOverviewMode(false);
        s.setUseWideViewPort(true);
        s.setAllowFileAccess(false);
        s.setAllowContentAccess(false);
        s.setUserAgentString(s.getUserAgentString() + " " + UA_TOKEN + "/" + versionName() + (bundled.count() > 0 ? " bundled" : ""));
        web.setWebChromeClient(new WebChromeClient());
        web.setWebViewClient(new Client());
        FrameLayout root = new FrameLayout(this);
        root.setBackgroundColor(Color.rgb(0x0c, 0x0f, 0x0e));
        root.addView(web, new FrameLayout.LayoutParams(FrameLayout.LayoutParams.MATCH_PARENT, FrameLayout.LayoutParams.MATCH_PARENT));
        root.setOnApplyWindowInsetsListener(this::keepClearOfCutout);
        setContentView(root);
        hideSystemBars();

        String saved = prefs.getString(PREF_SERVER, null);
        if (saved != null) open(saved);
        else pickServer(false);
    }

    @Override
    protected void onResume() {
        super.onResume();
        web.onResume();
        hideSystemBars();
    }

    @Override
    protected void onPause() {
        web.onPause();
        super.onPause();
    }

    @Override
    protected void onDestroy() {
        if (dialog != null) dialog.dismiss();
        web.destroy();
        super.onDestroy();
    }

    @Override
    public void onWindowFocusChanged(boolean hasFocus) {
        super.onWindowFocusChanged(hasFocus);
        if (hasFocus) hideSystemBars();
    }

    /** Back: the game is one page (its own screens have their own 返回), so Back opens the app's menu. */
    @Override
    @SuppressWarnings("deprecation")
    public void onBackPressed() {
        if (server == null) {
            pickServer(false);
            return;
        }
        show(new AlertDialog.Builder(this)
            .setTitle(label(server))
            .setItems(new String[] { "重新载入", "切换服务器", "退出" }, (d, which) -> {
                if (which == 0) web.reload();
                else if (which == 1) pickServer(true);
                else finish();
            })
            .setNegativeButton("继续游戏", null));
    }

    // ---- server choice -------------------------------------------------------------------------------------------

    private void pickServer(boolean cancelable) {
        String[] items = new String[SERVERS.length + 1];
        for (int i = 0; i < SERVERS.length; i++) items[i] = SERVERS[i][0];
        items[SERVERS.length] = "其他服务器…";
        AlertDialog.Builder b = new AlertDialog.Builder(this)
            .setTitle("选择服务器")
            .setItems(items, (d, which) -> {
                if (which < SERVERS.length) choose(SERVERS[which][1]);
                else askCustom(cancelable);
            })
            .setCancelable(cancelable);
        if (cancelable) b.setNegativeButton("取消", null);
        show(b);
    }

    private void askCustom(boolean cancelable) {
        EditText input = new EditText(this);
        input.setInputType(InputType.TYPE_CLASS_TEXT | InputType.TYPE_TEXT_VARIATION_URI);
        input.setHint("https://example.com 或 http://192.168.1.10:3000");
        String current = server != null && !isListed(server) ? server : prefs.getString("custom", "");
        input.setText(current);
        show(new AlertDialog.Builder(this)
            .setTitle("服务器地址")
            .setView(input)
            .setCancelable(cancelable)
            .setPositiveButton("连接", (d, w) -> {
                String origin = origin(input.getText().toString());
                if (origin == null) askCustom(cancelable);
                else {
                    prefs.edit().putString("custom", origin).apply();
                    choose(origin);
                }
            })
            .setNegativeButton("返回", (d, w) -> pickServer(cancelable)));
    }

    private void choose(String origin) {
        prefs.edit().putString(PREF_SERVER, origin).apply();
        open(origin);
    }

    private void open(String origin) {
        server = origin;
        bundled.setServer(origin);
        web.loadUrl(origin + "/");
    }

    /** "example.com", "https://example.com/x" → "https://example.com"; null when it is no http(s) address. */
    private static String origin(String text) {
        String t = text == null ? "" : text.trim();
        if (t.isEmpty()) return null;
        if (!t.contains("://")) t = "https://" + t;
        Uri u = Uri.parse(t);
        String scheme = u.getScheme();
        if (u.getHost() == null || u.getHost().isEmpty() || !("https".equals(scheme) || "http".equals(scheme))) return null;
        String host = java.net.IDN.toASCII(u.getHost());
        return scheme + "://" + host + (u.getPort() > 0 ? ":" + u.getPort() : "");
    }

    private static boolean isListed(String origin) {
        for (String[] s : SERVERS) if (s[1].equals(origin)) return true;
        return false;
    }

    private static String label(String origin) {
        for (String[] s : SERVERS) if (s[1].equals(origin)) return s[0];
        return origin;
    }

    // ---- page loading --------------------------------------------------------------------------------------------

    private final class Client extends WebViewClient {
        @Override
        public WebResourceResponse shouldInterceptRequest(WebView view, WebResourceRequest request) {
            return bundled.intercept(request);
        }

        /** Pages stay in the app (the game, a sign-in); other schemes (mailto:, an app link) go to the system. */
        @Override
        public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
            String scheme = request.getUrl().getScheme();
            if ("http".equals(scheme) || "https".equals(scheme)) return false;
            try {
                startActivity(new Intent(Intent.ACTION_VIEW, request.getUrl()));
            } catch (ActivityNotFoundException ignored) {
                // nothing handles it
            }
            return true;
        }

        @Override
        public void onReceivedError(WebView view, WebResourceRequest request, WebResourceError error) {
            if (!request.isForMainFrame()) return;
            show(new AlertDialog.Builder(MainActivity.this)
                .setTitle("无法连接服务器")
                .setMessage(label(server) + "\n" + error.getDescription())
                .setCancelable(false)
                .setPositiveButton("重试", (d, w) -> web.reload())
                .setNeutralButton("切换服务器", (d, w) -> pickServer(false))
                .setNegativeButton("退出", (d, w) -> finish()));
        }
    }

    // ---- window ----------------------------------------------------------------------------------------------------

    private void show(AlertDialog.Builder b) {
        runOnUiThread(() -> {
            if (isFinishing()) return;
            if (dialog != null && dialog.isShowing()) dialog.dismiss();
            dialog = b.create();
            dialog.setOnDismissListener(d -> hideSystemBars());
            dialog.show();
        });
    }

    /**
     * The page stays clear of a camera cutout, as in Chrome: the window reaches under it (Android 15 draws every app
     * edge to edge), and a WebView does not always report the cutout to the page's safe-area insets (css/devices.css).
     */
    @SuppressWarnings("deprecation")
    private WindowInsets keepClearOfCutout(View v, WindowInsets insets) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.P) return insets;
        DisplayCutout c = insets.getDisplayCutout();
        if (c == null) v.setPadding(0, 0, 0, 0);
        else v.setPadding(c.getSafeInsetLeft(), c.getSafeInsetTop(), c.getSafeInsetRight(), c.getSafeInsetBottom());
        return Build.VERSION.SDK_INT >= Build.VERSION_CODES.R ? WindowInsets.CONSUMED : insets.consumeDisplayCutout();
    }

    /** Full screen: the status and navigation bars hide, a swipe from an edge shows them for a moment. */
    @SuppressWarnings("deprecation")
    private void hideSystemBars() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
            getWindow().setDecorFitsSystemWindows(false);
            WindowInsetsController c = getWindow().getInsetsController();
            if (c != null) {
                c.hide(WindowInsets.Type.statusBars() | WindowInsets.Type.navigationBars());
                c.setSystemBarsBehavior(WindowInsetsController.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE);
            }
        } else {
            getWindow().getDecorView().setSystemUiVisibility(View.SYSTEM_UI_FLAG_IMMERSIVE_STICKY
                | View.SYSTEM_UI_FLAG_FULLSCREEN | View.SYSTEM_UI_FLAG_HIDE_NAVIGATION
                | View.SYSTEM_UI_FLAG_LAYOUT_STABLE | View.SYSTEM_UI_FLAG_LAYOUT_FULLSCREEN
                | View.SYSTEM_UI_FLAG_LAYOUT_HIDE_NAVIGATION);
        }
    }

    private String versionName() {
        try {
            return getPackageManager().getPackageInfo(getPackageName(), 0).versionName;
        } catch (PackageManager.NameNotFoundException e) {
            return "0";
        }
    }
}
