package app.nodpilot.plugins.auth;

import android.app.Activity;
import android.content.Intent;
import android.net.Uri;
import android.os.Handler;
import android.os.Looper;
import androidx.activity.result.ActivityResult;
import androidx.browser.customtabs.CustomTabsIntent;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.ActivityCallback;
import com.getcapacitor.annotation.CapacitorPlugin;

@CapacitorPlugin(name = "NodAuth")
public class NodAuthPlugin extends Plugin {

    private final Handler main = new Handler(Looper.getMainLooper());
    private PluginCall pending;
    private boolean awaitingReturn;
    private boolean pausedForAuth;
    private final Runnable cancelAfterResume = new Runnable() {
        @Override
        public void run() {
            PluginCall call = pending;
            if (!awaitingReturn || call == null) return;
            awaitingReturn = false;
            pending = null;
            pausedForAuth = false;
            call.reject("canceled");
        }
    };

    @PluginMethod
    public void google(PluginCall call) {
        String raw = call.getString("url", "https://nodpilot.com/login?native_return=1");
        Uri uri = Uri.parse(raw);
        if (uri == null || uri.getScheme() == null) {
            call.reject("Invalid URL");
            return;
        }
        pending = call;
        call.setKeepAlive(true);
        awaitingReturn = true;
        pausedForAuth = false;
        main.removeCallbacks(cancelAfterResume);
        getActivity()
            .runOnUiThread(
                () -> {
                    try {
                        CustomTabsIntent tabs = new CustomTabsIntent.Builder().setShowTitle(true).build();
                        tabs.launchUrl(getActivity(), uri);
                    } catch (Exception e) {
                        Intent sheet = new Intent(getContext(), NodAuthActivity.class);
                        sheet.putExtra(NodAuthActivity.EXTRA_URL, raw);
                        startActivityForResult(call, sheet, "onAuthSheet");
                    }
                }
            );
    }

    @ActivityCallback
    private void onAuthSheet(PluginCall call, ActivityResult result) {
        awaitingReturn = false;
        pending = null;
        pausedForAuth = false;
        main.removeCallbacks(cancelAfterResume);
        if (call == null) return;
        Intent data = result.getData();
        String token = data != null ? data.getStringExtra(NodAuthActivity.EXTRA_TOKEN) : null;
        if (token != null && !token.isEmpty()) {
            resolveToken(call, token);
            return;
        }
        if (result.getResultCode() == Activity.RESULT_CANCELED) {
            call.reject("canceled");
            return;
        }
        String err = data != null ? data.getStringExtra(NodAuthActivity.EXTRA_ERROR) : null;
        call.reject(err != null && !err.isEmpty() ? err : "Google sign-in failed");
    }

    @Override
    protected void handleOnNewIntent(Intent intent) {
        super.handleOnNewIntent(intent);
        if (intent == null || intent.getData() == null) return;
        Uri uri = intent.getData();
        if (!"nodpilot".equals(uri.getScheme())) return;
        String token = uri.getQueryParameter("token");
        if (token == null || token.isEmpty()) return;
        PluginCall call = pending;
        awaitingReturn = false;
        pending = null;
        pausedForAuth = false;
        main.removeCallbacks(cancelAfterResume);
        if (call != null) {
            resolveToken(call, token);
        }
    }

    @Override
    protected void handleOnPause() {
        super.handleOnPause();
        if (awaitingReturn) pausedForAuth = true;
        main.removeCallbacks(cancelAfterResume);
    }

    @Override
    protected void handleOnResume() {
        super.handleOnResume();
        if (!awaitingReturn || pending == null || !pausedForAuth) return;
        main.removeCallbacks(cancelAfterResume);
        main.postDelayed(cancelAfterResume, 1200);
    }

    private void resolveToken(PluginCall call, String token) {
        JSObject out = new JSObject();
        out.put("token", token);
        out.put("url", "nodpilot://auth?token=" + Uri.encode(token));
        call.resolve(out);
    }
}
