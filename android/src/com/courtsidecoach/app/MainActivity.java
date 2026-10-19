package com.courtsidecoach.app;

import android.Manifest;
import android.app.Activity;
import android.content.ContentValues;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.graphics.Color;
import android.net.Uri;
import android.os.Bundle;
import android.speech.tts.TextToSpeech;
import android.view.WindowManager;
import android.webkit.JavascriptInterface;
import android.webkit.PermissionRequest;
import android.webkit.ValueCallback;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;

import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.util.HashMap;
import java.util.Locale;
import java.util.Map;

/**
 * Hosts the coaching web app from APK assets in a WebView.
 * Assets are served under a fake https origin so the page is a secure
 * context (camera access, WebAssembly fetches) without any network.
 */
public class MainActivity extends Activity {
    private static final String HOST = "appassets.courtside";
    private static final String ORIGIN = "https://" + HOST + "/";
    private static final int REQ_CAMERA = 7;

    private WebView web;
    private TextToSpeech tts;
    private boolean ttsReady;
    private PermissionRequest pendingRequest;
    private int utteranceId;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
        getWindow().setStatusBarColor(Color.rgb(11, 23, 38));
        getWindow().setNavigationBarColor(Color.BLACK);

        WebView.setWebContentsDebuggingEnabled(true);
        web = new WebView(this);
        web.setBackgroundColor(Color.rgb(11, 23, 38));
        setContentView(web);

        WebSettings s = web.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);
        s.setMediaPlaybackRequiresUserGesture(false);
        s.setAllowFileAccess(false);
        s.setAllowContentAccess(false);

        web.setWebViewClient(new WebViewClient() {
            @Override
            public WebResourceResponse shouldInterceptRequest(WebView view, WebResourceRequest request) {
                if (!HOST.equals(request.getUrl().getHost())) return null;
                return serveAsset(request.getUrl().getPath());
            }

            @Override
            public boolean shouldOverrideUrlLoading(WebView view, String url) {
                return !url.startsWith(ORIGIN);
            }
        });

        web.setWebChromeClient(new WebChromeClient() {
            @Override
            public void onPermissionRequest(final PermissionRequest request) {
                runOnUiThread(new Runnable() {
                    @Override
                    public void run() {
                        handlePermission(request);
                    }
                });
            }
        });

        web.addJavascriptInterface(new NativeBridge(), "TennisNative");

        tts = new TextToSpeech(this, new TextToSpeech.OnInitListener() {
            @Override
            public void onInit(int status) {
                if (status != TextToSpeech.SUCCESS) return;
                int r = tts.setLanguage(Locale.KOREAN);
                ttsReady = r != TextToSpeech.LANG_MISSING_DATA && r != TextToSpeech.LANG_NOT_SUPPORTED;
                tts.setSpeechRate(1.05f);
            }
        });

        web.loadUrl(ORIGIN + "index.html");
    }

    private void handlePermission(PermissionRequest request) {
        boolean wantsVideo = false;
        for (String r : request.getResources()) {
            if (PermissionRequest.RESOURCE_VIDEO_CAPTURE.equals(r)) wantsVideo = true;
        }
        if (!wantsVideo) {
            request.deny();
            return;
        }
        if (checkSelfPermission(Manifest.permission.CAMERA) == PackageManager.PERMISSION_GRANTED) {
            request.grant(new String[] {PermissionRequest.RESOURCE_VIDEO_CAPTURE});
        } else {
            pendingRequest = request;
            requestPermissions(new String[] {Manifest.permission.CAMERA}, REQ_CAMERA);
        }
    }

    @Override
    public void onRequestPermissionsResult(int requestCode, String[] permissions, int[] grantResults) {
        if (requestCode != REQ_CAMERA || pendingRequest == null) return;
        if (grantResults.length > 0 && grantResults[0] == PackageManager.PERMISSION_GRANTED) {
            pendingRequest.grant(new String[] {PermissionRequest.RESOURCE_VIDEO_CAPTURE});
        } else {
            pendingRequest.deny();
        }
        pendingRequest = null;
    }

    private WebResourceResponse serveAsset(String path) {
        if (path == null || path.equals("/") || path.isEmpty()) path = "/index.html";
        if (path.contains("..")) return notFound();
        String file = "www" + path;
        String mime = mimeOf(path);
        boolean text = mime.startsWith("text/") || mime.endsWith("json") || mime.endsWith("svg+xml");
        try {
            InputStream in = getAssets().open(file);
            Map<String, String> headers = new HashMap<String, String>();
            headers.put("Access-Control-Allow-Origin", "*");
            headers.put("Cache-Control", "no-cache");
            return new WebResourceResponse(mime, text ? "utf-8" : null, 200, "OK", headers, in);
        } catch (IOException e) {
            return notFound();
        }
    }

    private static WebResourceResponse notFound() {
        return new WebResourceResponse("text/plain", "utf-8", 404, "Not Found",
                new HashMap<String, String>(), null);
    }

    private static String mimeOf(String path) {
        String p = path.toLowerCase(Locale.ROOT);
        if (p.endsWith(".html")) return "text/html";
        if (p.endsWith(".js") || p.endsWith(".mjs")) return "text/javascript";
        if (p.endsWith(".css")) return "text/css";
        if (p.endsWith(".wasm")) return "application/wasm";
        if (p.endsWith(".json")) return "application/json";
        if (p.endsWith(".png")) return "image/png";
        if (p.endsWith(".svg")) return "image/svg+xml";
        return "application/octet-stream";
    }

    /** Exposed to the page as window.TennisNative. */
    private class NativeBridge {
        @JavascriptInterface
        public void speak(String text) {
            if (!ttsReady || text == null) return;
            tts.speak(text, TextToSpeech.QUEUE_FLUSH, null, "u" + (utteranceId++));
        }

        @JavascriptInterface
        public void stop() {
            if (tts != null) tts.stop();
        }

        /**
         * Saves text to Download/CourtsideCoach (MediaStore, Android 10+) and opens the
         * share sheet for it. Returns the folder path, or "" on failure.
         * Column names are spelled out because this compiles against API 23.
         */
        @JavascriptInterface
        public String saveAndShare(String name, String content) {
            try {
                ContentValues v = new ContentValues();
                v.put("_display_name", name);
                v.put("mime_type", "application/json");
                v.put("relative_path", "Download/CourtsideCoach");
                final Uri uri = getContentResolver().insert(Uri.parse("content://media/external/downloads"), v);
                if (uri == null) return "";
                OutputStream out = getContentResolver().openOutputStream(uri);
                try {
                    out.write(content.getBytes("UTF-8"));
                } finally {
                    out.close();
                }
                runOnUiThread(new Runnable() {
                    @Override
                    public void run() {
                        Intent send = new Intent(Intent.ACTION_SEND);
                        send.setType("application/json");
                        send.putExtra(Intent.EXTRA_STREAM, uri);
                        send.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);
                        startActivity(Intent.createChooser(send, "스윙 데이터 보내기"));
                    }
                });
                return "다운로드/CourtsideCoach";
            } catch (Exception e) {
                return "";
            }
        }

        @JavascriptInterface
        public boolean hasVoice() {
            return ttsReady;
        }
    }

    @Override
    public void onBackPressed() {
        web.evaluateJavascript("window.courtsideBack ? window.courtsideBack() : false",
                new ValueCallback<String>() {
                    @Override
                    public void onReceiveValue(String handled) {
                        if (!"true".equals(handled)) finish();
                    }
                });
    }

    @Override
    protected void onPause() {
        super.onPause();
        if (tts != null) tts.stop();
    }

    @Override
    protected void onDestroy() {
        if (tts != null) tts.shutdown();
        if (web != null) web.destroy();
        super.onDestroy();
    }
}
