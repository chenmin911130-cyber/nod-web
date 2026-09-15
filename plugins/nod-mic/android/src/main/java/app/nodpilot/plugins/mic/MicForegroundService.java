package app.nodpilot.plugins.mic;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Intent;
import android.content.pm.ServiceInfo;
import android.net.wifi.WifiManager;
import android.os.Build;
import android.os.IBinder;
import android.os.PowerManager;
import androidx.core.app.NotificationCompat;
import androidx.core.app.ServiceCompat;

/** Keeps CPU, Wi-Fi, and the microphone FGS alive while Listen is running with the screen off. */
public class MicForegroundService extends Service {

    public static final String ACTION_START = "app.nodpilot.plugins.mic.START";
    public static final String ACTION_STOP = "app.nodpilot.plugins.mic.STOP";
    private static final String CHANNEL = "nod.listening";
    private static final int NOTE_ID = 71;
    private static final String WAKE_TAG = "nodpilot:listen";

    private PowerManager.WakeLock wakeLock;
    private WifiManager.WifiLock wifiLock;

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        String action = intent != null ? intent.getAction() : ACTION_START;
        if (ACTION_STOP.equals(action)) {
            releaseLocks();
            stopForeground(STOP_FOREGROUND_REMOVE);
            stopSelf();
            return START_NOT_STICKY;
        }
        ensureChannel();
        Intent launch = getPackageManager().getLaunchIntentForPackage(getPackageName());
        PendingIntent tap = launch == null
            ? null
            : PendingIntent.getActivity(
                this,
                0,
                launch,
                PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE
            );
        NotificationCompat.Builder builder = new NotificationCompat.Builder(this, CHANNEL)
            .setContentTitle("Nodpilot")
            .setContentText("Listening — tap to return to the app")
            .setSmallIcon(android.R.drawable.ic_btn_speak_now)
            .setOngoing(true)
            .setContentIntent(tap)
            .setSound(null)
            .setPriority(NotificationCompat.PRIORITY_DEFAULT);
        if (Build.VERSION.SDK_INT >= 31) {
            builder.setForegroundServiceBehavior(NotificationCompat.FOREGROUND_SERVICE_IMMEDIATE);
        }
        Notification note = builder.build();
        if (Build.VERSION.SDK_INT >= 29) {
            ServiceCompat.startForeground(this, NOTE_ID, note, ServiceInfo.FOREGROUND_SERVICE_TYPE_MICROPHONE);
        } else {
            startForeground(NOTE_ID, note);
        }
        acquireLocks();
        return START_NOT_STICKY;
    }

    @Override
    public void onDestroy() {
        releaseLocks();
        stopForeground(STOP_FOREGROUND_REMOVE);
        super.onDestroy();
    }

    @Override
    public IBinder onBind(Intent intent) {
        return null;
    }

    private void acquireLocks() {
        if (wakeLock == null) {
            PowerManager pm = getSystemService(PowerManager.class);
            if (pm != null) {
                wakeLock = pm.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, WAKE_TAG);
                wakeLock.setReferenceCounted(false);
            }
        }
        if (wakeLock != null && !wakeLock.isHeld()) {
            wakeLock.acquire(6 * 60 * 60 * 1000L);
        }
        try {
            WifiManager wifi = getApplicationContext().getSystemService(WifiManager.class);
            if (wifi != null && wifiLock == null) {
                @SuppressWarnings("deprecation")
                WifiManager.WifiLock lock = wifi.createWifiLock(WifiManager.WIFI_MODE_FULL_HIGH_PERF, WAKE_TAG);
                lock.setReferenceCounted(false);
                wifiLock = lock;
            }
            if (wifiLock != null && !wifiLock.isHeld()) {
                wifiLock.acquire();
            }
        } catch (Exception ignored) {
            /* no Wi-Fi radio, or OEM blocked the lock */
        }
    }

    private void releaseLocks() {
        if (wakeLock != null && wakeLock.isHeld()) {
            wakeLock.release();
        }
        if (wifiLock != null && wifiLock.isHeld()) {
            wifiLock.release();
        }
    }

    private void ensureChannel() {
        if (Build.VERSION.SDK_INT < 26) return;
        NotificationManager mgr = getSystemService(NotificationManager.class);
        if (mgr == null || mgr.getNotificationChannel(CHANNEL) != null) return;
        NotificationChannel channel = new NotificationChannel(CHANNEL, "Listening", NotificationManager.IMPORTANCE_DEFAULT);
        channel.setDescription("Shown while Nodpilot is listening");
        channel.setSound(null, null);
        channel.enableVibration(false);
        mgr.createNotificationChannel(channel);
    }
}
