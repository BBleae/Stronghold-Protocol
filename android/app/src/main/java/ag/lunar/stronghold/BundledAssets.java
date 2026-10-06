package ag.lunar.stronghold;

import android.content.res.AssetManager;
import android.net.Uri;
import android.util.Log;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.util.Collections;
import java.util.HashMap;
import java.util.Locale;
import java.util.Map;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;

/**
 * The game's resources inside the APK (assets/game/…, written by tools/build-android.mjs from a server's
 * /resource-manifest.json; docs/ANDROID.md). A GET of the chosen server's /assets/… or /fonts/… — and of the
 * extension-less /media/… audio route the client uses (shared/media.js) — is answered from the APK when the server
 * lists the very same file (its sha256). Everything else goes to the network as in a browser: the game's code and
 * data (so the app always runs the server's own version), and any file the server added or changed since this build.
 */
final class BundledAssets {
    private static final String TAG = "BundledAssets";
    /** shared/media.js AUDIO_EXTS: the extensions a /media/… request resolves to, in the server's order. */
    private static final String[] AUDIO_EXTS = { ".mp3", ".m4a", ".aac", ".ogg", ".oga", ".opus", ".wav" };
    /** How long a request waits for the server's manifest before trusting the APK's files as they are. */
    private static final long MANIFEST_WAIT_MS = 4000;

    private static final class Entry {
        final String file;   // asset path inside the APK: game/<url path, decoded>
        final String sha256;
        final String type;
        final long size;

        Entry(String file, String sha256, String type, long size) {
            this.file = file;
            this.sha256 = sha256;
            this.type = type;
            this.size = size;
        }
    }

    private final AssetManager assets;
    /** decoded url path → entry (e.g. "/assets/local/map/fx/[opt]merged_textures.png"). */
    private final Map<String, Entry> byPath = new HashMap<>();
    /** "/media/bgm/act1" → the decoded path of "/assets/audio/bgm/act1.mp3". */
    private final Map<String, String> media = new HashMap<>();
    private final String builtFrom;

    private volatile String host;
    /** The chosen server's files: decoded path → sha256; empty when it publishes no manifest (then the APK's are used). */
    private volatile Map<String, String> serverFiles = Collections.emptyMap();
    private volatile CountDownLatch serverReady = new CountDownLatch(0);

    BundledAssets(AssetManager assets) {
        this.assets = assets;
        String from = "";
        try (InputStream in = assets.open("game/manifest.json")) {
            JSONObject manifest = new JSONObject(readAll(in));
            from = manifest.optString("server", "");
            JSONArray files = manifest.getJSONArray("files");
            for (int i = 0; i < files.length(); i++) {
                JSONObject f = files.getJSONObject(i);
                String path = Uri.decode(f.getString("url"));
                byPath.put(path, new Entry("game" + path, f.getString("sha256"), f.optString("type", guessType(path)), f.optLong("size", -1)));
                String key = mediaKey(path);
                if (key != null && (!media.containsKey(key) || extRank(path) < extRank(media.get(key)))) media.put(key, path);
            }
        } catch (IOException e) {
            Log.i(TAG, "no bundled resources (a build without them): every file comes from the server");
        } catch (Exception e) {
            Log.w(TAG, "bundled manifest unreadable", e);
        }
        builtFrom = from;
        Log.i(TAG, byPath.size() + " bundled files" + (from.isEmpty() ? "" : " (from " + from + ")"));
    }

    int count() {
        return byPath.size();
    }

    /** The server the APK's resources were taken from (tools/build-android.mjs --server), "" when unknown. */
    String builtFrom() {
        return builtFrom;
    }

    /** A server was chosen: its requests may be answered from the APK, once its manifest says which files still match. */
    void setServer(String origin) {
        host = Uri.parse(origin).getHost();
        serverFiles = Collections.emptyMap();
        if (byPath.isEmpty()) {
            serverReady = new CountDownLatch(0);
            return;
        }
        CountDownLatch latch = new CountDownLatch(1);
        serverReady = latch;
        Thread t = new Thread(() -> {
            try {
                serverFiles = fetchManifest(origin + "/resource-manifest.json");
            } finally {
                latch.countDown();
            }
        }, "resource-manifest");
        t.setDaemon(true);
        t.start();
    }

    /** The APK's copy of a request (called on WebView's IO thread), or null for the network. */
    WebResourceResponse intercept(WebResourceRequest request) {
        if (byPath.isEmpty() || !"GET".equalsIgnoreCase(request.getMethod())) return null;
        Uri url = request.getUrl();
        String h = host;
        if (h == null || !h.equalsIgnoreCase(url.getHost())) return null;
        String path = url.getPath();
        if (path == null) return null;
        if (path.startsWith("/media/")) path = media.get(path);
        Entry entry = path == null ? null : byPath.get(path);
        if (entry == null) return null;
        try {
            serverReady.await(MANIFEST_WAIT_MS, TimeUnit.MILLISECONDS);
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
        }
        Map<String, String> server = serverFiles;
        if (!server.isEmpty() && !entry.sha256.equals(server.get(path))) return null; // changed or gone on the server
        try {
            InputStream in = assets.open(entry.file);
            Map<String, String> headers = new HashMap<>();
            headers.put("Access-Control-Allow-Origin", "*");
            headers.put("Cache-Control", "no-cache");
            if (entry.size >= 0) headers.put("Content-Length", Long.toString(entry.size));
            return new WebResourceResponse(entry.type, null, 200, "OK", headers, in);
        } catch (IOException e) {
            Log.w(TAG, "missing in the APK: " + entry.file, e);
            return null;
        }
    }

    /** "/assets/audio/bgm/act1.mp3" → "/media/bgm/act1" (public/js/media.js mediaUrl), or null. */
    private static String mediaKey(String path) {
        if (!path.regionMatches(true, 0, "/assets/audio/", 0, 14)) return null;
        String rest = path.substring(14);
        String lower = rest.toLowerCase(Locale.ROOT);
        for (String ext : AUDIO_EXTS) {
            if (lower.endsWith(ext)) return "/media/" + rest.substring(0, rest.length() - ext.length());
        }
        return null;
    }

    /** A /media/… request resolves to the first of AUDIO_EXTS that exists, as on the server. */
    private static int extRank(String path) {
        String p = path.toLowerCase(Locale.ROOT);
        for (int i = 0; i < AUDIO_EXTS.length; i++) if (p.endsWith(AUDIO_EXTS[i])) return i;
        return AUDIO_EXTS.length;
    }

    private static Map<String, String> fetchManifest(String url) {
        HttpURLConnection c = null;
        try {
            c = (HttpURLConnection) new URL(url).openConnection();
            c.setConnectTimeout(8000);
            c.setReadTimeout(15000);
            c.setRequestProperty("Cache-Control", "no-cache");
            if (c.getResponseCode() != 200) return Collections.emptyMap();
            JSONArray files;
            try (InputStream in = c.getInputStream()) {
                files = new JSONObject(readAll(in)).getJSONArray("files");
            }
            Map<String, String> out = new HashMap<>(files.length() * 2);
            for (int i = 0; i < files.length(); i++) {
                JSONObject f = files.getJSONObject(i);
                out.put(Uri.decode(f.getString("url")), f.getString("sha256"));
            }
            Log.i(TAG, out.size() + " files listed by " + url);
            return out;
        } catch (Exception e) {
            Log.w(TAG, "server manifest unavailable (" + url + "): the APK's files are used as they are", e);
            return Collections.emptyMap();
        } finally {
            if (c != null) c.disconnect();
        }
    }

    private static String guessType(String path) {
        String p = path.toLowerCase(Locale.ROOT);
        if (p.endsWith(".png")) return "image/png";
        if (p.endsWith(".webp")) return "image/webp";
        if (p.endsWith(".jpg") || p.endsWith(".jpeg")) return "image/jpeg";
        if (p.endsWith(".mp3")) return "audio/mpeg";
        if (p.endsWith(".ogg")) return "audio/ogg";
        if (p.endsWith(".json")) return "application/json";
        if (p.endsWith(".css")) return "text/css";
        if (p.endsWith(".woff2")) return "font/woff2";
        if (p.endsWith(".ttf")) return "font/ttf";
        if (p.endsWith(".otf")) return "font/otf";
        return "application/octet-stream";
    }

    private static String readAll(InputStream in) throws IOException {
        ByteArrayOutputStream out = new ByteArrayOutputStream();
        byte[] buf = new byte[64 * 1024];
        for (int n; (n = in.read(buf)) > 0; ) out.write(buf, 0, n);
        return out.toString("UTF-8");
    }
}
