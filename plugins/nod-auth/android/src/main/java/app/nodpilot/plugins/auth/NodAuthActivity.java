package app.nodpilot.plugins.auth;

import android.annotation.SuppressLint;
import android.content.Intent;
import android.graphics.Color;
import android.net.Uri;
import android.os.Bundle;
import android.view.Gravity;
import android.view.ViewGroup;
import android.webkit.CookieManager;
import android.webkit.JavascriptInterface;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceError;
import android.webkit.WebResourceRequest;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.ImageButton;
import android.widget.LinearLayout;
import android.widget.TextView;
import androidx.appcompat.app.AppCompatActivity;

/**
 * In-app login sheet, matching the iPhone NodAuth WKWebView: intercept
 * nodpilot://, watch localStorage.nod_token, close button cancels.
 */
public class NodAuthActivity extends AppCompatActivity {

    public static final String EXTRA_URL = "url";
    public static final String EXTRA_TOKEN = "token";
    public static final String EXTRA_ERROR = "error";

    private static final String WATCH_SCRIPT =
        "(function () {" +
        "  if (window.__nodAuthWatch) return;" +
        "  window.__nodAuthWatch = true;" +
        "  try { sessionStorage.setItem('nod_native_return', '1'); } catch (e) {}" +
        "  function send(token) {" +
        "    if (!token) return;" +
        "    try { window.nodAuth.token(String(token)); } catch (e) {}" +
        "  }" +
        "  function read() {" +
        "    try { return localStorage.getItem('nod_token') || ''; } catch (e) { return ''; }" +
        "  }" +
        "  var seen = read();" +
        "  if (seen) { send(seen); return; }" +
        "  setInterval(function () {" +
        "    var token = read();" +
        "    if (token && token !== seen) { seen = token; send(token); }" +
        "  }, 350);" +
        "})();";

    private WebView webView;
    private boolean settled;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        String start = getIntent() != null ? getIntent().getStringExtra(EXTRA_URL) : null;
        if (start == null || start.isEmpty()) {
            start = "https://nodpilot.com/login?native_return=1";
        }

        int bg = Color.rgb(5, 7, 10);
        LinearLayout root = new LinearLayout(this);
        root.setOrientation(LinearLayout.VERTICAL);
        root.setBackgroundColor(bg);

        LinearLayout bar = new LinearLayout(this);
        bar.setOrientation(LinearLayout.HORIZONTAL);
        bar.setGravity(Gravity.CENTER_VERTICAL);
        int pad = dp(12);
        bar.setPadding(pad, pad, pad, pad);
        bar.setBackgroundColor(bg);

        ImageButton close = new ImageButton(this);
        close.setImageResource(android.R.drawable.ic_menu_close_clear_cancel);
        close.setBackgroundColor(Color.TRANSPARENT);
        close.setColorFilter(Color.WHITE);
        close.setOnClickListener(v -> settleCancel());
        bar.addView(close, new LinearLayout.LayoutParams(dp(40), dp(40)));

        TextView title = new TextView(this);
        title.setText("Sign in");
        title.setTextColor(Color.WHITE);
        title.setTextSize(18);
        title.setPadding(dp(8), 0, 0, 0);
        bar.addView(title, new LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1));

        webView = new WebView(this);
        configureWebView(webView);
        root.addView(bar, new LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT));
        root.addView(webView, new LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, 0, 1));
        setContentView(root);

        webView.loadUrl(start);
    }

    @SuppressLint("SetJavaScriptEnabled")
    private void configureWebView(WebView web) {
        WebSettings settings = web.getSettings();
        settings.setJavaScriptEnabled(true);
        settings.setDomStorageEnabled(true);
        settings.setDatabaseEnabled(true);
        settings.setJavaScriptCanOpenWindowsAutomatically(true);
        settings.setSupportMultipleWindows(false);
        String ua = settings.getUserAgentString();
        if (ua != null) {
            settings.setUserAgentString(ua.replace("; wv", "").replace(" Version/4.0", ""));
        }
        CookieManager cookies = CookieManager.getInstance();
        cookies.setAcceptCookie(true);
        cookies.setAcceptThirdPartyCookies(web, true);
        web.setBackgroundColor(Color.rgb(5, 7, 10));
        web.addJavascriptInterface(new Bridge(), "nodAuth");
        web.setWebChromeClient(new WebChromeClient());
        web.setWebViewClient(
            new WebViewClient() {
                @Override
                public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
                    return handleUri(request.getUrl());
                }

                @Override
                @SuppressWarnings("deprecation")
                public boolean shouldOverrideUrlLoading(WebView view, String url) {
                    return handleUri(Uri.parse(url));
                }

                @Override
                public void onPageFinished(WebView view, String url) {
                    view.evaluateJavascript(WATCH_SCRIPT, null);
                }

                @Override
                public void onReceivedError(WebView view, WebResourceRequest request, WebResourceError error) {
                    if (request == null || !request.isForMainFrame() || settled) return;
                    if (error != null && error.getDescription() != null) {
                        settleError(error.getDescription().toString());
                    }
                }
            }
        );
    }

    private boolean handleUri(Uri uri) {
        if (uri == null) return false;
        if ("nodpilot".equals(uri.getScheme())) {
            String token = uri.getQueryParameter("token");
            if (token != null && !token.isEmpty()) {
                settleToken(token);
            }
            return true;
        }
        return false;
    }

    private class Bridge {
        @JavascriptInterface
        public void token(String value) {
            if (value == null || value.isEmpty()) return;
            runOnUiThread(() -> settleToken(value));
        }
    }

    private void settleToken(String token) {
        if (settled) return;
        settled = true;
        Intent data = new Intent();
        data.putExtra(EXTRA_TOKEN, token);
        setResult(RESULT_OK, data);
        finish();
    }

    private void settleCancel() {
        if (settled) return;
        settled = true;
        setResult(RESULT_CANCELED);
        finish();
    }

    private void settleError(String message) {
        if (settled) return;
        settled = true;
        Intent data = new Intent();
        data.putExtra(EXTRA_ERROR, message);
        setResult(RESULT_FIRST_USER, data);
        finish();
    }

    @Override
    public void onBackPressed() {
        if (webView != null && webView.canGoBack()) {
            webView.goBack();
            return;
        }
        settleCancel();
    }

    @Override
    protected void onDestroy() {
        if (webView != null) {
            webView.removeJavascriptInterface("nodAuth");
            webView.destroy();
        }
        super.onDestroy();
    }

    private int dp(int value) {
        return Math.round(value * getResources().getDisplayMetrics().density);
    }
}
