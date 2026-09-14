package app.nodpilot.plugins.mic;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Intent;
import android.content.pm.ServiceInfo;
import android.os.Build;
import android.os.IBinder;
import androidx.core.app.NotificationCompat;
import androidx.core.app.ServiceCompat;

/** Keeps the process alive while Listen is running (lock-screen / pocket). */
public class MicForegroundService extends Service {

    public static final String ACTION_START = "app.nodpilot.plugins.mic.START";
    public static final String ACTION_STOP = "app.nodpilot.plugins.mic.STOP";
    private static final String CHANNEL = "nod.listening";
    private static final int NOTE_ID = 71;

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        String action = intent != null ? intent.getAction() : ACTION_START;
        if (ACTION_STOP.equals(action)) {
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
        Notification note = new NotificationCompat.Builder(this, CHANNEL)
            .setContentTitle("Nodpilot")
            .setContentText("Listening — tap to return to the app")
            .setSmallIcon(android.R.drawable.ic_btn_speak_now)
            .setOngoing(true)
            .setContentIntent(tap)
            .setSilent(true)
            .build();
        if (Build.VERSION.SDK_INT >= 34) {
            ServiceCompat.startForeground(this, NOTE_ID, note, ServiceInfo.FOREGROUND_SERVICE_TYPE_MICROPHONE);
        } else {
            startForeground(NOTE_ID, note);
        }
        return START_STICKY;
    }

    @Override
    public IBinder onBind(Intent intent) {
        return null;
    }

    private void ensureChannel() {
        if (Build.VERSION.SDK_INT < 26) return;
        NotificationManager mgr = getSystemService(NotificationManager.class);
        if (mgr == null || mgr.getNotificationChannel(CHANNEL) != null) return;
        NotificationChannel channel = new NotificationChannel(CHANNEL, "Listening", NotificationManager.IMPORTANCE_LOW);
        channel.setDescription("Shown while Nodpilot is listening");
        channel.setSound(null, null);
        mgr.createNotificationChannel(channel);
    }
}
