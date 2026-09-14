package app.nodpilot.plugins.mic;

import android.content.Context;
import java.io.File;
import java.io.FileOutputStream;
import java.nio.charset.StandardCharsets;
import java.text.SimpleDateFormat;
import java.util.ArrayList;
import java.util.Date;
import java.util.List;
import java.util.Locale;
import java.util.TimeZone;
import org.json.JSONObject;

/**
 * Phone-side PCM archive used by History. Android has no Watch ingest, but
 * list/delete must still match the iPhone plugin contract.
 */
final class PhonePcmStore {

    static final class CaptureInfo {
        final String captureId;
        final String sessionId;
        final int bytes;
        final boolean sealed;
        final String intent;
        final String modifiedAt;
        final String mode;

        CaptureInfo(String captureId, String sessionId, int bytes, boolean sealed, String intent, String modifiedAt, String mode) {
            this.captureId = captureId;
            this.sessionId = sessionId;
            this.bytes = bytes;
            this.sealed = sealed;
            this.intent = intent;
            this.modifiedAt = modifiedAt;
            this.mode = mode;
        }
    }

    private static final long DISK_LIMIT = 256L * 1024L * 1024L;
    private static PhonePcmStore instance;
    private final File root;
    private final Object lock = new Object();
    private String liveId = "";
    private FileOutputStream liveOut;
    private int liveBytes;

    static synchronized PhonePcmStore get(Context context) {
        if (instance == null) {
            instance = new PhonePcmStore(context.getApplicationContext());
        }
        return instance;
    }

    private PhonePcmStore(Context context) {
        root = new File(context.getFilesDir(), "nod-phone-pcm");
        //noinspection ResultOfMethodCallIgnored
        root.mkdirs();
    }

    void begin(String captureId) {
        synchronized (lock) {
            closeLocked();
            liveId = captureId == null ? "" : captureId;
            liveBytes = 0;
            if (liveId.isEmpty()) return;
            File dir = new File(root, liveId);
            //noinspection ResultOfMethodCallIgnored
            dir.mkdirs();
            File pcm = new File(dir, "audio.pcm");
            try {
                liveOut = new FileOutputStream(pcm, true);
                liveBytes = (int) pcm.length();
                writeManifestLocked(false, "", "");
            } catch (Exception e) {
                liveOut = null;
            }
        }
    }

    void append(byte[] data, int n) {
        if (data == null || n <= 0) return;
        synchronized (lock) {
            if (liveOut == null) return;
            if (usedBytesLocked() + n > DISK_LIMIT) return;
            try {
                liveOut.write(data, 0, n);
                liveOut.flush();
                liveBytes += n;
            } catch (Exception ignored) {}
        }
    }

    void bind(String sessionId, String mode) {
        synchronized (lock) {
            if (liveId.isEmpty()) return;
            writeManifestLocked(false, sessionId == null ? "" : sessionId, mode == null ? "" : mode);
        }
    }

    void seal() {
        synchronized (lock) {
            writeManifestLocked(true, readFieldLocked("sessionId"), readFieldLocked("mode"));
            closeLocked();
        }
    }

    List<CaptureInfo> list() {
        List<CaptureInfo> out = new ArrayList<>();
        File[] dirs = root.listFiles();
        if (dirs == null) return out;
        SimpleDateFormat iso = new SimpleDateFormat("yyyy-MM-dd'T'HH:mm:ss'Z'", Locale.US);
        iso.setTimeZone(TimeZone.getTimeZone("UTC"));
        for (File dir : dirs) {
            if (!dir.isDirectory()) continue;
            File pcm = new File(dir, "audio.pcm");
            int size = pcm.isFile() ? (int) pcm.length() : 0;
            if (size <= 0 && !dir.getName().equals(liveId)) continue;
            JSONObject meta = readManifest(dir);
            out.add(
                new CaptureInfo(
                    dir.getName(),
                    meta.optString("sessionId", ""),
                    size,
                    meta.optBoolean("sealed", false),
                    meta.optString("intent", "none"),
                    iso.format(new Date(dir.lastModified())),
                    meta.optString("mode", "")
                )
            );
        }
        out.sort((a, b) -> b.modifiedAt.compareTo(a.modifiedAt));
        return out;
    }

    int deleteCapture(String id) {
        if (id == null || id.isEmpty()) return 0;
        synchronized (lock) {
            if (id.equals(liveId) && liveOut != null) return 0;
            File dir = new File(root, id);
            File pcm = new File(dir, "audio.pcm");
            int size = pcm.isFile() ? (int) pcm.length() : 0;
            if (!deleteTree(dir)) return 0;
            return size;
        }
    }

    int deleteSession(String sessionId) {
        if (sessionId == null || sessionId.isEmpty()) return 0;
        int freed = 0;
        File[] dirs = root.listFiles();
        if (dirs == null) return 0;
        for (File dir : dirs) {
            if (!dir.isDirectory()) continue;
            JSONObject meta = readManifest(dir);
            if (!sessionId.equals(meta.optString("sessionId", ""))) continue;
            freed += deleteCapture(dir.getName());
        }
        return freed;
    }

    private void closeLocked() {
        try {
            if (liveOut != null) liveOut.close();
        } catch (Exception ignored) {}
        liveOut = null;
        liveId = "";
        liveBytes = 0;
    }

    private long usedBytesLocked() {
        long n = 0;
        File[] dirs = root.listFiles();
        if (dirs == null) return liveBytes;
        for (File dir : dirs) {
            File pcm = new File(dir, "audio.pcm");
            if (pcm.isFile()) n += pcm.length();
        }
        return n;
    }

    private void writeManifestLocked(boolean sealed, String sessionId, String mode) {
        if (liveId.isEmpty()) return;
        File dir = new File(root, liveId);
        try {
            JSONObject meta = readManifest(dir);
            meta.put("captureId", liveId);
            if (!sessionId.isEmpty()) meta.put("sessionId", sessionId);
            if (!mode.isEmpty()) meta.put("mode", mode);
            meta.put("sealed", sealed);
            meta.put("bytes", liveBytes);
            File out = new File(dir, "manifest.json");
            FileOutputStream fos = new FileOutputStream(out);
            fos.write(meta.toString().getBytes(StandardCharsets.UTF_8));
            fos.close();
        } catch (Exception ignored) {}
    }

    private String readFieldLocked(String key) {
        if (liveId.isEmpty()) return "";
        return readManifest(new File(root, liveId)).optString(key, "");
    }

    private static JSONObject readManifest(File dir) {
        File file = new File(dir, "manifest.json");
        if (!file.isFile()) return new JSONObject();
        try {
            java.io.FileInputStream in = new java.io.FileInputStream(file);
            byte[] raw = new byte[(int) file.length()];
            int got = in.read(raw);
            in.close();
            if (got <= 0) return new JSONObject();
            return new JSONObject(new String(raw, 0, got, StandardCharsets.UTF_8));
        } catch (Exception e) {
            return new JSONObject();
        }
    }

    private static boolean deleteTree(File dir) {
        File[] kids = dir.listFiles();
        if (kids != null) {
            for (File kid : kids) {
                if (kid.isDirectory()) deleteTree(kid);
                else //noinspection ResultOfMethodCallIgnored
                    kid.delete();
            }
        }
        return dir.delete();
    }
}
