package app.nodpilot.plugins.mic;

import android.Manifest;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.media.AudioFormat;
import android.media.AudioRecord;
import android.media.MediaRecorder;
import android.os.Build;
import android.os.Process;
import android.os.SystemClock;
import android.util.Base64;
import android.util.Log;
import androidx.core.content.ContextCompat;
import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.PermissionState;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.getcapacitor.annotation.Permission;
import com.getcapacitor.annotation.PermissionCallback;

@CapacitorPlugin(
    name = "NodMic",
    permissions = {
        @Permission(alias = "mic", strings = { Manifest.permission.RECORD_AUDIO }),
        @Permission(alias = "notify", strings = { Manifest.permission.POST_NOTIFICATIONS })
    }
)
public class NodMicPlugin extends Plugin {

    private static final String TAG = "NodMic";
    private static final int SAMPLE_RATE = 16_000;
    private static final int FRAME = 3200;
    private final Object recLock = new Object();
    private volatile boolean running;
    private AudioRecord recorder;
    private Thread recThread;

    @PluginMethod
    public void start(PluginCall call) {
        if (running) {
            call.resolve();
            return;
        }
        if (getPermissionState("mic") != PermissionState.GRANTED) {
            if (Build.VERSION.SDK_INT >= 33) {
                requestPermissionForAliases(new String[] { "mic", "notify" }, call, "onMicPerm");
            } else {
                requestPermissionForAlias("mic", call, "onMicPerm");
            }
            return;
        }
        beginCapture(call);
    }

    @PermissionCallback
    private void onMicPerm(PluginCall call) {
        if (getPermissionState("mic") != PermissionState.GRANTED) {
            call.reject("Microphone permission denied");
            return;
        }
        beginCapture(call);
    }

    @PluginMethod
    public void stop(PluginCall call) {
        teardown();
        call.resolve();
    }

    @PluginMethod
    public void isActive(PluginCall call) {
        JSObject out = new JSObject();
        out.put("active", running);
        call.resolve(out);
    }

    @PluginMethod
    public void startKeepAlive(PluginCall call) {
        startService();
        call.resolve();
    }

    @PluginMethod
    public void stopKeepAlive(PluginCall call) {
        if (!running) stopService();
        call.resolve();
    }

    @PluginMethod
    public void resume(PluginCall call) {
        if (running) {
            restartRecorder();
        }
        call.resolve();
    }

    @PluginMethod
    public void startUplink(PluginCall call) {
        String url = call.getString("url");
        if (url == null || url.isEmpty()) {
            call.reject("Missing url");
            return;
        }
        AudioUplink.get()
            .start(
                url,
                error -> {
                    if (error != null) call.reject(error);
                    else call.resolve();
                }
            );
    }

    @PluginMethod
    public void stopUplink(PluginCall call) {
        AudioUplink.get().stop();
        call.resolve();
    }

    @PluginMethod
    public void listPendingCaptures(PluginCall call) {
        JSArray rows = new JSArray();
        for (PhonePcmStore.CaptureInfo info : PhonePcmStore.get(getContext()).list()) {
            JSObject row = new JSObject();
            row.put("captureId", info.captureId);
            row.put("sessionId", info.sessionId);
            row.put("bytes", info.bytes);
            row.put("sealed", info.sealed);
            row.put("intent", info.intent);
            row.put("modifiedAt", info.modifiedAt);
            row.put("mode", info.mode);
            rows.put(row);
        }
        JSObject out = new JSObject();
        out.put("captures", rows);
        call.resolve(out);
    }

    @PluginMethod
    public void deletePendingCapture(PluginCall call) {
        PhonePcmStore store = PhonePcmStore.get(getContext());
        int freed = 0;
        String id = call.getString("captureId", "");
        String sid = call.getString("sessionId", "");
        if (id != null && !id.isEmpty()) freed += store.deleteCapture(id);
        if (sid != null && !sid.isEmpty()) freed += store.deleteSession(sid);
        JSObject out = new JSObject();
        out.put("freed", freed);
        call.resolve(out);
    }

    private void beginCapture(PluginCall call) {
        running = true;
        startService();
        if (!startRecorder()) {
            running = false;
            stopService();
            call.reject("Microphone is not ready");
            return;
        }
        call.resolve();
    }

    private boolean startRecorder() {
        haltRecorder();
        if (!openRecorder()) return false;
        recThread = new Thread(this::readLoop, "nod-mic");
        recThread.start();
        return true;
    }

    private boolean openRecorder() {
        synchronized (recLock) {
            if (recorder != null) return true;
            if (ContextCompat.checkSelfPermission(getContext(), Manifest.permission.RECORD_AUDIO) != PackageManager.PERMISSION_GRANTED) {
                return false;
            }
            int min = AudioRecord.getMinBufferSize(SAMPLE_RATE, AudioFormat.CHANNEL_IN_MONO, AudioFormat.ENCODING_PCM_16BIT);
            if (min <= 0) return false;
            int buf = Math.max(min * 4, FRAME * 4);
            AudioRecord next;
            try {
                next = new AudioRecord(MediaRecorder.AudioSource.MIC, SAMPLE_RATE, AudioFormat.CHANNEL_IN_MONO, AudioFormat.ENCODING_PCM_16BIT, buf);
            } catch (Exception e) {
                Log.w(TAG, "AudioRecord open failed", e);
                return false;
            }
            if (next.getState() != AudioRecord.STATE_INITIALIZED) {
                next.release();
                return false;
            }
            next.startRecording();
            if (next.getRecordingState() != AudioRecord.RECORDSTATE_RECORDING) {
                next.release();
                return false;
            }
            recorder = next;
            return true;
        }
    }

    private void releaseRecorder() {
        AudioRecord rec;
        synchronized (recLock) {
            rec = recorder;
            recorder = null;
        }
        if (rec == null) return;
        try {
            rec.stop();
        } catch (Exception ignored) {}
        rec.release();
    }

    private void readLoop() {
        Process.setThreadPriority(Process.THREAD_PRIORITY_URGENT_AUDIO);
        byte[] buf = new byte[FRAME];
        int failStreak = 0;
        long lastKick = 0;
        while (running) {
            long now = SystemClock.elapsedRealtime();
            if (CaptureLoopPolicy.shouldRefreshForeground(now, lastKick)) {
                startService();
                lastKick = now;
            }
            AudioRecord rec;
            synchronized (recLock) {
                rec = recorder;
            }
            if (rec == null) {
                if (!openRecorder()) {
                    failStreak++;
                    sleepQuiet(CaptureLoopPolicy.reopenDelayMs(failStreak));
                    continue;
                }
                failStreak = 0;
                continue;
            }
            int n;
            try {
                n = rec.read(buf, 0, buf.length);
            } catch (Exception e) {
                n = AudioRecord.ERROR_INVALID_OPERATION;
            }
            if (CaptureLoopPolicy.shouldReopenRecorder(running, n)) {
                releaseRecorder();
                failStreak++;
                sleepQuiet(CaptureLoopPolicy.reopenDelayMs(failStreak));
                continue;
            }
            if (!running) break;
            if (n <= 0) continue;
            failStreak = 0;
            if (AudioUplink.get().isEnabled()) {
                AudioUplink.get().enqueue(buf, n);
                continue;
            }
            String b64 = Base64.encodeToString(buf, 0, n, Base64.NO_WRAP);
            JSObject ev = new JSObject();
            ev.put("data", b64);
            android.app.Activity host = getActivity();
            if (host != null) {
                host.runOnUiThread(() -> notifyListeners("pcm", ev));
            }
        }
    }

    private static void sleepQuiet(long ms) {
        try {
            Thread.sleep(ms);
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
        }
    }

    private void restartRecorder() {
        if (!running) return;
        startService();
        startRecorder();
    }

    private void teardown() {
        running = false;
        haltRecorder();
        stopService();
    }

    private void haltRecorder() {
        Thread t;
        synchronized (recLock) {
            t = recThread;
            recThread = null;
        }
        releaseRecorder();
        if (t != null && t != Thread.currentThread()) {
            t.interrupt();
            try {
                t.join(400);
            } catch (InterruptedException ignored) {
                Thread.currentThread().interrupt();
            }
        }
    }

    private void startService() {
        Intent i = new Intent(getContext(), MicForegroundService.class);
        i.setAction(MicForegroundService.ACTION_START);
        try {
            if (Build.VERSION.SDK_INT >= 26) {
                getContext().startForegroundService(i);
            } else {
                getContext().startService(i);
            }
        } catch (Exception e) {
            Log.e(TAG, "microphone foreground service failed", e);
            try {
                getContext().startService(i);
            } catch (Exception ignored) {}
        }
    }

    private void stopService() {
        getContext().stopService(new Intent(getContext(), MicForegroundService.class));
    }

    @Override
    public void load() {
        super.load();
        PhonePcmStore.get(getContext());
    }
}
