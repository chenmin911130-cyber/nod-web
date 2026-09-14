package app.nodpilot.plugins.mic;

import java.util.ArrayDeque;
import java.util.concurrent.TimeUnit;
import okhttp3.OkHttpClient;
import okhttp3.Request;
import okhttp3.Response;
import okhttp3.WebSocket;
import okhttp3.WebSocketListener;
import okio.ByteString;
import org.json.JSONObject;

/**
 * Native PCM WebSocket so lock-screen capture does not go through the WebView.
 * Binary frames match iOS AudioUplink: 16 kHz PCM16, 100 ms / 3200 bytes.
 */
final class AudioUplink {

    interface StartCallback {
        void onDone(String error);
    }

    private static final int SAMPLE_BYTES_PER_SEC = 16_000 * 2;
    private static final int MIN_CHUNK = 1600;
    private static final int FRAME_BYTES = 3200;
    private static final int MAX_PENDING = 2 * 1024 * 1024;

    private static final AudioUplink INSTANCE = new AudioUplink();

    static AudioUplink get() {
        return INSTANCE;
    }

    private final Object lock = new Object();
    private final ArrayDeque<byte[]> pending = new ArrayDeque<>();
    private final OkHttpClient client = new OkHttpClient.Builder()
        .pingInterval(0, TimeUnit.SECONDS)
        .build();

    private boolean enabled;
    private boolean connected;
    private boolean stopped = true;
    private boolean sending;
    private String url = "";
    private WebSocket socket;
    private byte[] stash = new byte[0];
    private int pendingBytes;
    private int reconnectAttempt;
    private StartCallback startCb;
    private final android.os.Handler io = new android.os.Handler(android.os.Looper.getMainLooper());
    private long lastSendAt;
    private double lastSentAudioSeconds;
    private final Runnable ping = this::sendPing;
    private final Runnable timeout = this::onStartTimeout;
    private final Runnable pump = this::pump;
    private final Runnable reconnect = this::open;

    boolean isEnabled() {
        synchronized (lock) {
            return enabled;
        }
    }

    void start(String nextUrl, StartCallback cb) {
        synchronized (lock) {
            if (nextUrl.equals(url) && enabled && !stopped) {
                cb.onDone(null);
                return;
            }
            url = nextUrl;
            stopped = false;
            reconnectAttempt = 0;
            startCb = cb;
            io.removeCallbacks(timeout);
            io.postDelayed(timeout, 8000);
        }
        open();
    }

    void stop() {
        synchronized (lock) {
            finishStartLocked("Audio uplink stopped");
            stopped = true;
            enabled = false;
            connected = false;
            sending = false;
            pending.clear();
            pendingBytes = 0;
            stash = new byte[0];
            lastSendAt = 0;
            lastSentAudioSeconds = 0;
            io.removeCallbacks(ping);
            io.removeCallbacks(timeout);
            io.removeCallbacks(pump);
            io.removeCallbacks(reconnect);
            if (socket != null) {
                socket.close(1001, "goingAway");
                socket = null;
            }
        }
    }

    void enqueue(byte[] data, int n) {
        if (data == null || n <= 0) return;
        synchronized (lock) {
            if (stopped || !enabled) return;
            stash = concat(stash, data, n);
            while (stash.length >= FRAME_BYTES) {
                byte[] frame = slice(stash, 0, FRAME_BYTES);
                stash = slice(stash, FRAME_BYTES, stash.length - FRAME_BYTES);
                bufferLocked(frame);
            }
        }
        schedulePump();
    }

    private void open() {
        String target;
        synchronized (lock) {
            if (stopped || url.isEmpty()) return;
            if (socket != null) {
                socket.cancel();
                socket = null;
            }
            connected = false;
            target = url;
        }
        Request req = new Request.Builder().url(target).build();
        client.newWebSocket(req, new WebSocketListener() {
            @Override
            public void onOpen(WebSocket webSocket, Response response) {
                synchronized (lock) {
                    socket = webSocket;
                    connected = true;
                    enabled = true;
                    reconnectAttempt = 0;
                    finishStartLocked(null);
                }
                io.removeCallbacks(ping);
                io.postDelayed(ping, 20_000);
                schedulePump();
            }

            @Override
            public void onMessage(WebSocket webSocket, String text) {
                /* pcm_end / watch copy are Watch-side; phone listen ignores. */
            }

            @Override
            public void onClosing(WebSocket webSocket, int code, String reason) {
                webSocket.close(code, reason);
            }

            @Override
            public void onClosed(WebSocket webSocket, int code, String reason) {
                if (code == 4404) {
                    synchronized (lock) {
                        stopped = true;
                        enabled = false;
                        connected = false;
                        socket = null;
                        finishStartLocked("Listen session ended");
                    }
                    return;
                }
                handleDrop();
            }

            @Override
            public void onFailure(WebSocket webSocket, Throwable t, Response response) {
                int status = response != null ? response.code() : 0;
                if (status >= 400 && status < 500) {
                    synchronized (lock) {
                        stopped = true;
                        enabled = false;
                        connected = false;
                        socket = null;
                        finishStartLocked("Audio uplink did not connect");
                    }
                    return;
                }
                handleDrop();
            }
        });
    }

    private void handleDrop() {
        synchronized (lock) {
            if (stopped) return;
            connected = false;
            sending = false;
            socket = null;
            io.removeCallbacks(ping);
            int delay = (int) Math.min(30_000, 1000 * Math.pow(2, reconnectAttempt));
            reconnectAttempt = Math.min(reconnectAttempt + 1, 5);
            io.removeCallbacks(reconnect);
            io.postDelayed(reconnect, Math.max(1000, delay));
        }
    }

    private void onStartTimeout() {
        synchronized (lock) {
            if (startCb == null) return;
            stopped = true;
            enabled = false;
            connected = false;
            if (socket != null) {
                socket.cancel();
                socket = null;
            }
            finishStartLocked("Audio uplink did not connect");
        }
    }

    private void finishStartLocked(String error) {
        io.removeCallbacks(timeout);
        StartCallback cb = startCb;
        startCb = null;
        if (cb != null) {
            io.post(() -> cb.onDone(error));
        }
    }

    private void bufferLocked(byte[] frame) {
        pending.addLast(frame);
        pendingBytes += frame.length;
        while (pendingBytes > MAX_PENDING && !pending.isEmpty()) {
            byte[] oldest = pending.removeFirst();
            pendingBytes -= oldest.length;
        }
    }

    private void schedulePump() {
        io.removeCallbacks(pump);
        long waitMs = 0;
        synchronized (lock) {
            if (lastSendAt != 0) {
                double elapsed = (System.nanoTime() - lastSendAt) / 1e9;
                waitMs = Math.max(0, (long) ((lastSentAudioSeconds - elapsed) * 1000));
            }
        }
        io.postDelayed(pump, waitMs);
    }

    private void pump() {
        byte[] frame;
        WebSocket ws;
        synchronized (lock) {
            if (stopped || !connected || sending || socket == null || pending.isEmpty()) return;
            frame = pending.peekFirst();
            if (frame == null) return;
            if (frame.length < MIN_CHUNK) {
                byte[] padded = new byte[MIN_CHUNK];
                System.arraycopy(frame, 0, padded, 0, frame.length);
                frame = padded;
            }
            sending = true;
            ws = socket;
        }
        boolean ok = ws.send(ByteString.of(frame));
        synchronized (lock) {
            sending = false;
            if (!ok) {
                handleDrop();
                return;
            }
            byte[] queued = pending.pollFirst();
            if (queued != null) pendingBytes -= queued.length;
            lastSendAt = System.nanoTime();
            lastSentAudioSeconds = frame.length / (double) SAMPLE_BYTES_PER_SEC;
        }
        schedulePump();
    }

    private void sendPing() {
        WebSocket ws;
        synchronized (lock) {
            if (stopped || !connected) return;
            ws = socket;
        }
        if (ws != null) {
            try {
                ws.send(new JSONObject().put("type", "ping").toString());
            } catch (Exception ignored) {}
        }
        io.postDelayed(ping, 20_000);
    }

    private static byte[] concat(byte[] a, byte[] b, int n) {
        byte[] out = new byte[a.length + n];
        System.arraycopy(a, 0, out, 0, a.length);
        System.arraycopy(b, 0, out, a.length, n);
        return out;
    }

    private static byte[] slice(byte[] src, int off, int len) {
        byte[] out = new byte[len];
        System.arraycopy(src, off, out, 0, len);
        return out;
    }
}
