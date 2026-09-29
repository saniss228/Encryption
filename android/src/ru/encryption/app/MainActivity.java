package ru.encryption.app;

import android.Manifest;
import android.annotation.SuppressLint;
import android.app.Activity;
import android.content.pm.PackageManager;
import android.app.DownloadManager;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.os.Environment;
import android.util.Log;
import android.view.KeyEvent;
import android.view.View;
import android.webkit.ConsoleMessage;
import android.webkit.CookieManager;
import android.webkit.JavascriptInterface;
import android.webkit.PermissionRequest;
import android.webkit.ValueCallback;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceRequest;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.Toast;

import java.io.File;

/**
 * Encryption — Android-приложение.
 *
 * Это нативная оболочка вокруг того же клиента, что работает на сайте
 * и на ПК: шифрование (AES-256-GCM + RSA-4096-OAEP) выполняется тем же
 * ядром crypto.js внутри WebView, приватные ключи не покидают устройство.
 *
 * Особенности оболочки:
 *   • UI грузится из локальных assets (работает и без сети);
 *   • адрес сервера настраивается и хранится в SharedPreferences;
 *   • аппаратная кнопка «назад» уходит в веб-клиент;
 *   • доступ к микрофону/камере для звонков, скачивание файлов;
 *   • системные уведомления и «режим защиты» (запрет скриншотов) — опционально.
 */
public class MainActivity extends Activity {

    private WebView web;
    private SharedPreferences prefs;
    private ValueCallback<Uri[]> filePathCallback;
    private static final String DEFAULT_SERVER = "http://45.90.45.92:3000"; // порт сервера и приложений
    private static final int FILE_CHOOSER = 1001;
    private static final int REQ_MEDIA = 1002;      // микрофон/камера для звонков

    // Запрос WebView (getUserMedia) ждёт, пока пользователь разрешит доступ в системе
    private PermissionRequest pendingMediaRequest;

    @SuppressLint({"SetJavaScriptEnabled", "AddJavascriptInterface"})
    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        prefs = getSharedPreferences("encryption", MODE_PRIVATE);

        web = new WebView(this);
        setContentView(web);

        WebSettings s = web.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);                 // localStorage для ключей/кэша
        s.setDatabaseEnabled(true);
        s.setAllowFileAccess(true);
        s.setAllowContentAccess(true);
        s.setLoadWithOverviewMode(true);
        s.setUseWideViewPort(true);
        s.setMediaPlaybackRequiresUserGesture(false);
        s.setMixedContentMode(WebSettings.MIXED_CONTENT_ALWAYS_ALLOW); // http-сервер + https-оболочка
        if (Build.VERSION.SDK_INT >= 21) {
            s.setAllowUniversalAccessFromFileURLs(true); // fetch к серверу из file:// UI
            s.setAllowFileAccessFromFileURLs(true);
        }
        if (Build.VERSION.SDK_INT >= 26) {
            web.setImportantForAutofill(View.IMPORTANT_FOR_AUTOFILL_NO_EXCLUDE_DESCENDANTS);
        }
        CookieManager.getInstance().setAcceptCookie(true);

        web.addJavascriptInterface(new NativeBridge(), "AndroidNative");

        web.setWebViewClient(new WebViewClient() {
            @Override
            public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest req) {
                Uri u = req.getUrl();
                String scheme = u.getScheme() == null ? "" : u.getScheme();
                if (scheme.startsWith("http") && !u.getHost().equals("45.90.45.92")
                        && !u.getHost().endsWith(".encryption.local")) {
                    startActivity(new Intent(Intent.ACTION_VIEW, u));
                    return true;
                }
                return false;
            }
        });

        web.setWebChromeClient(new WebChromeClient() {
            @Override
            public void onPermissionRequest(final PermissionRequest request) {
                // Микрофон/камера нужны для звонков и голосовых сообщений.
                // Мало разрешить запрос WebView: Android требует ещё системное
                // разрешение приложения — иначе доступ молча не выдаётся
                // (именно из-за этого на телефоне «не было микрофона»).
                runOnUiThread(() -> grantMedia(request));
            }

            @Override
            public boolean onShowFileChooser(WebView v, ValueCallback<Uri[]> cb, FileChooserParams params) {
                filePathCallback = cb;
                Intent intent = params.createIntent();
                try { startActivityForResult(intent, FILE_CHOOSER); } catch (Exception e) { filePathCallback = null; return false; }
                return true;
            }

            @Override
            public boolean onConsoleMessage(ConsoleMessage cm) {
                // Сообщения клиента идут в системный журнал Android —
                // его видно через «adb logcat -s EncryptionJS» без отладки страницы
                Log.d("EncryptionJS", cm.messageLevel() + ": " + cm.message()
                        + " (" + cm.sourceId() + ":" + cm.lineNumber() + ")");
                return true;
            }
        });

        askMediaPermissionsOnStart();

        String url = "file:///android_asset/www/index.html?server="
                + Uri.encode(prefs.getString("server", DEFAULT_SERVER));
        web.loadUrl(url);
    }

    /* ── Разрешения для звонков и голосовых сообщений ───────────────────── */

    /**
     * Спрашиваем микрофон, камеру и уведомления при запуске: без системного
     * разрешения запись голосового и звонок не начнутся, а пользователь
     * увидит лишь невнятную ошибку. Спрашиваем только то, что ещё не выдано.
     */
    private void askMediaPermissionsOnStart() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.M) return;
        java.util.List<String> need = new java.util.ArrayList<>();
        if (checkSelfPermission(Manifest.permission.RECORD_AUDIO) != PackageManager.PERMISSION_GRANTED) {
            need.add(Manifest.permission.RECORD_AUDIO);
        }
        if (checkSelfPermission(Manifest.permission.CAMERA) != PackageManager.PERMISSION_GRANTED) {
            need.add(Manifest.permission.CAMERA);
        }
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU
                && checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED) {
            need.add(Manifest.permission.POST_NOTIFICATIONS);
        }
        if (!need.isEmpty()) {
            requestPermissions(need.toArray(new String[0]), REQ_MEDIA);
        }
    }

    /** Какие системные разрешения нужны для запроса WebView. */
    private String[] neededPermissions(PermissionRequest request) {
        java.util.List<String> need = new java.util.ArrayList<>();
        for (String res : request.getResources()) {
            if (PermissionRequest.RESOURCE_AUDIO_CAPTURE.equals(res)
                    && checkSelfPermission(Manifest.permission.RECORD_AUDIO) != PackageManager.PERMISSION_GRANTED) {
                need.add(Manifest.permission.RECORD_AUDIO);
            }
            if (PermissionRequest.RESOURCE_VIDEO_CAPTURE.equals(res)
                    && checkSelfPermission(Manifest.permission.CAMERA) != PackageManager.PERMISSION_GRANTED) {
                need.add(Manifest.permission.CAMERA);
            }
        }
        return need.toArray(new String[0]);
    }

    /** Выдать запрос WebView, если системные разрешения уже есть; иначе — спросить. */
    private void grantMedia(PermissionRequest request) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.M) {
            request.grant(request.getResources());
            return;
        }
        String[] need = neededPermissions(request);
        if (need.length == 0) {
            request.grant(request.getResources());
            return;
        }
        pendingMediaRequest = request;                 // выдадим после ответа пользователя
        requestPermissions(need, REQ_MEDIA);
    }

    @Override
    public void onRequestPermissionsResult(int code, String[] permissions, int[] results) {
        super.onRequestPermissionsResult(code, permissions, results);
        if (code != REQ_MEDIA || pendingMediaRequest == null) return;
        PermissionRequest request = pendingMediaRequest;
        pendingMediaRequest = null;
        if (neededPermissions(request).length == 0) {
            request.grant(request.getResources());     // всё разрешено — звонок/запись начинается
        } else {
            request.deny();                            // пользователь отказал — веб-клиент скажет об этом
        }
    }

    /** Мост «нативная часть ↔ веб-клиент». */
    private class NativeBridge {
        @JavascriptInterface
        public String getServer() { return prefs.getString("server", DEFAULT_SERVER); }

        @JavascriptInterface
        public void setServer(String url) {
            prefs.edit().putString("server", url).apply();
        }

        @JavascriptInterface
        public String getPlatform() { return "android"; }

        @JavascriptInterface
        public String getAppVersion() { return "3.4.1"; }

        @JavascriptInterface
        public void toast(String text) {
            runOnUiThread(() -> Toast.makeText(MainActivity.this, text, Toast.LENGTH_SHORT).show());
        }

        /** Сохранить расшифрованный файл в «Загрузки». */
        @JavascriptInterface
        public void saveToDownloads(String base64, String fileName, String mime) {
            try {
                byte[] data = android.util.Base64.decode(base64, android.util.Base64.DEFAULT);
                File dir = new File(getExternalFilesDir(null), "Encryption");
                if (!dir.exists()) dir.mkdirs();
                File out = new File(dir, fileName);
                java.io.FileOutputStream fos = new java.io.FileOutputStream(out);
                fos.write(data); fos.close();
                runOnUiThread(() -> Toast.makeText(MainActivity.this,
                        "Сохранено: " + out.getAbsolutePath(), Toast.LENGTH_LONG).show());
            } catch (Exception e) {
                runOnUiThread(() -> Toast.makeText(MainActivity.this, "Не удалось сохранить: " + e, Toast.LENGTH_LONG).show());
            }
        }

        /** Запустить системное уведомление (для новых сообщений в фоне). */
        @JavascriptInterface
        public void notify(String title, String body) {
            Notifications.show(MainActivity.this, title, body);
        }
    }

    @Override
    protected void onActivityResult(int requestCode, int resultCode, Intent data) {
        if (requestCode == FILE_CHOOSER) {
            if (filePathCallback != null) {
                Uri[] results = null;
                if (resultCode == RESULT_OK && data != null && data.getDataString() != null) {
                    results = new Uri[]{Uri.parse(data.getDataString())};
                }
                filePathCallback.onReceiveValue(results);
                filePathCallback = null;
            }
            return;
        }
        super.onActivityResult(requestCode, resultCode, data);
    }

    @Override
    public boolean onKeyDown(int keyCode, KeyEvent event) {
        if (keyCode == KeyEvent.KEYCODE_BACK && web != null) {
            web.evaluateJavascript(
                "(function(){ return window.EncryptionHandleBack ? window.EncryptionHandleBack() : false; })();",
                value -> { if (!"true".equals(value)) finish(); });
            return true;
        }
        return super.onKeyDown(keyCode, event);
    }
}
