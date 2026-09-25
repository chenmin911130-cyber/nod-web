package app.nodpilot.plugins.mic;

import android.os.Handler;
import android.os.HandlerThread;
import android.os.Looper;
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
        .pingInterval(15, TimeUnit.SECONDS)
        .build();

    private boolean enabled;
    private boolean connected;
    private boolean stopped = true;
    private boolean sending;
    private String url = "";
    private WebSocket socket;
    private int socketGen;
    private byte[] stash = new byte[0];
    private int pendingBytes;
    private int reconnectAttempt;
    private StartCallback startCb;
    private final HandlerThread ioThread = new HandlerThread("nod-uplink");
    private final Handler io;
    private final Handler main = new Handler(Looper.getMainLooper());

    private AudioUplink() {
        ioThread.start();
        io = new Handler(ioThread.getLooper());
    }
    private final UplinkPacer pacer = new UplinkPacer();
    private long enqueuedBytes;
    private long sentBytes;
    private long droppedBytes;
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
                main.post(() -> cb.onDone(null));
                return;
            }
            if (startCb != null) {
                finishStartLocked("Audio uplink restarted");
            }
            url = nextUrl;
            stopped = false;
            reconnectAttempt = 0;
            enqueuedBytes = 0;
            sentBytes = 0;
            droppedBytes = 0;
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
            pacer.restoreDefaults();
            enqueuedBytes = 0;
            sentBytes = 0;
            droppedBytes = 0;
            socketGen++;
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
            enqueuedBytes += n;
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
        final int gen;
        String target;
        synchronized (lock) {
            if (stopped || url.isEmpty()) return;
            pacer.reset();
            socketGen++;
            gen = socketGen;
            if (socket != null) {
                socket.cancel();
                socket = null;
            }
            connected = false;
            target = url;
        }
        Request req = new Request.Builder().url(target).build();
        client.newWebSocket(
            req,
            new WebSocketListener() {
                private boolean current(WebSocket webSocket) {
                    synchronized (lock) {
                        return socketGen == gen && socket == webSocket;
                    }
                }

                @Override
                public void onOpen(WebSocket webSocket, Response response) {
                    synchronized (lock) {
                        if (stopped || socketGen != gen) {
                            webSocket.cancel();
                            return;
                        }
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
                    try {
                        JSONObject o = new JSONObject(text);
                        if ("uplink_config".equals(o.optString("type"))) {
                            synchronized (lock) {
                                pacer.applyConfig(
                                    o.has("pace") ? o.optString("pace") : null,
                                    o.has("catchup_rate") ? o.optDouble("catchup_rate") : null,
                                    o.has("coalesce_max") ? o.optInt("coalesce_max") : null
                                );
                            }
                        }
                    } catch (Exception ignored) {}
                }

                @Override
                public void onClosing(WebSocket webSocket, int code, String reason) {
                    if (current(webSocket)) webSocket.close(code, reason);
                }

                @Override
                public void onClosed(WebSocket webSocket, int code, String reason) {
                    synchronized (lock) {
                        if (socketGen != gen) return;
                        if (code == 4404) {
                            stopped = true;
                            enabled = false;
                            connected = false;
                            socket = null;
                            finishStartLocked("Listen session ended");
                            return;
                        }
                    }
                    handleDrop(gen);
                }

                @Override
                public void onFailure(WebSocket webSocket, Throwable t, Response response) {
                    synchronized (lock) {
                        if (socketGen != gen) return;
                        int status = response != null ? response.code() : 0;
                        if (status >= 400 && status < 500) {
                            stopped = true;
                            enabled = false;
                            connected = false;
                            socket = null;
                            finishStartLocked("Audio uplink did not connect");
                            return;
                        }
                    }
                    handleDrop(gen);
                }
            }
        );
    }

    private void handleDrop(int gen) {
        synchronized (lock) {
            if (stopped || socketGen != gen) return;
            pacer.reset();
            socketGen++;
            connected = false;
            sending = false;
            if (socket != null) {
                socket.cancel();
                socket = null;
            }
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
            pacer.reset();
            stopped = true;
            enabled = false;
            connected = false;
            socketGen++;
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
            main.post(() -> cb.onDone(error));
        }
    }

    private void bufferLocked(byte[] frame) {
        pending.addLast(frame);
        pendingBytes += frame.length;
        while (pendingBytes > MAX_PENDING && !pending.isEmpty()) {
            byte[] oldest = pending.removeFirst();
            pendingBytes -= oldest.length;
            droppedBytes += oldest.length;
        }
    }

    private void schedulePump() {
        io.removeCallbacks(pump);
        long waitMs;
        synchronized (lock) {
            waitMs = pacer.waitBeforeSendMs(System.nanoTime());
        }
        io.postDelayed(pump, waitMs);
    }

    private void pump() {
        byte[] msg;
        WebSocket ws;
        byte[][] batch;
        int batchBytes;
        synchronized (lock) {
            if (stopped || !connected || sending || socket == null || pending.isEmpty()) return;
            if (socket.queueSize() > 3L * FRAME_BYTES) {
                io.postDelayed(pump, 20);
                return;
            }
            int before = pending.size();
            int n = pacer.framesForMessage(before);
            if (n <= 0) return;
            batch = new byte[n][];
            batchBytes = 0;
            int i = 0;
            for (byte[] frame : pending) {
                if (i >= n) break;
                batch[i++] = frame;
                batchBytes += frame.length;
            }
            msg = new byte[batchBytes];
            int off = 0;
            for (byte[] frame : batch) {
                System.arraycopy(frame, 0, msg, off, frame.length);
                off += frame.length;
            }
            if (msg.length < MIN_CHUNK) {
                byte[] padded = new byte[MIN_CHUNK];
                System.arraycopy(msg, 0, padded, 0, msg.length);
                msg = padded;
            }
            pacer.noteSendStarted(System.nanoTime(), audioNanos(msg.length), before);
            sending = true;
            ws = socket;
        }
        boolean ok = ws.send(ByteString.of(msg));
        synchronized (lock) {
            sending = false;
            if (!ok) {
                handleDrop(socketGen);
                return;
            }
            for (byte[] frame : batch) {
                if (pending.peekFirst() == frame) {
                    pending.pollFirst();
                    pendingBytes -= frame.length;
                }
            }
            sentBytes += batchBytes;
            pacer.noteSendCompleted(System.nanoTime(), audioNanos(msg.length));
        }
        schedulePump();
    }

    private static long audioNanos(int bytes) {
        return (long) bytes * 1_000_000_000L / SAMPLE_BYTES_PER_SEC;
    }

    private void sendPing() {
        WebSocket ws;
        int pendingMs;
        long enqueuedMs;
        long sentMs;
        long droppedMs;
        synchronized (lock) {
            if (stopped || !connected || socket == null) return;
            ws = socket;
            pendingMs = (pendingBytes + stash.length) / 32;
            enqueuedMs = enqueuedBytes / 32;
            sentMs = sentBytes / 32;
            droppedMs = droppedBytes / 32;
        }
        long sockQueueMs = ws.queueSize() / 32;
        try {
            ws.send(new JSONObject()
                .put("type", "ping")
                .put("pending_ms", pendingMs)
                .put("enqueued_ms", enqueuedMs)
                .put("sent_ms", sentMs)
                .put("dropped_ms", droppedMs)
                .put("sock_queue_ms", sockQueueMs)
                .toString());
        } catch (Exception ignored) {}
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
