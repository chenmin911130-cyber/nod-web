package app.nodpilot.plugins.splash;

import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

@CapacitorPlugin(name = "NodSplash")
public class NodSplashPlugin extends Plugin {

    @PluginMethod
    public void splashReady(PluginCall call) {
        call.resolve();
    }
}
