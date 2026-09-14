package app.nodpilot.plugins.watch;

import android.content.Intent;
import android.content.SharedPreferences;
import android.media.MediaPlayer;
import android.net.Uri;
import android.util.Base64;
import androidx.core.content.FileProvider;
import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import java.io.File;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.util.ArrayList;
import org.json.JSONArray;
import org.json.JSONObject;

/**
 * Phone-side NodWatch methods (share / Files / TTS / account). Watch hardware
 * commands are no-ops on Android.
 */
@CapacitorPlugin(name = "NodWatch")
public class NodWatchPlugin extends Plugin {

    private MediaPlayer player;

    @PluginMethod
    public void ready(PluginCall call) {
        call.resolve();
    }

    @PluginMethod
    public void setStatus(PluginCall call) {
        call.resolve();
    }

    @PluginMethod
    public void shareFile(PluginCall call) {
        String b64 = call.getString("data");
        String name = call.getString("name");
        if (b64 == null || name == null) {
            call.reject("Missing file");
            return;
        }
        JSArray files = new JSArray();
        JSObject item = new JSObject();
        item.put("data", b64);
        item.put("name", name);
        files.put(item);
        call.getData().put("files", files);
        saveToFiles(call);
    }

    @PluginMethod
    public void saveToFiles(PluginCall call) {
        JSONArray items = call.getArray("files") != null ? call.getArray("files") : new JSArray();
        JSONArray remotes = call.getArray("remotes") != null ? call.getArray("remotes") : new JSArray();
        new Thread(() -> {
            try {
                ArrayList<Uri> uris = new ArrayList<>();
                for (int i = 0; i < items.length(); i++) {
                    JSONObject item = items.optJSONObject(i);
                    if (item == null) continue;
                    String b64 = item.optString("data", "");
                    String name = item.optString("name", "");
                    if (b64.isEmpty() || name.isEmpty()) continue;
                    byte[] data = Base64.decode(b64, Base64.DEFAULT);
                    File written = writeExport(data, name);
                    if (written != null) uris.add(uriFor(written));
                }
                int remoteFailed = 0;
                for (int i = 0; i < remotes.length(); i++) {
                    JSONObject remote = remotes.optJSONObject(i);
                    if (remote == null) {
                        remoteFailed++;
                        continue;
                    }
                    String url = remote.optString("url", "");
                    String name = remote.optString("name", "");
                    if (url.isEmpty() || name.isEmpty()) {
                        remoteFailed++;
                        continue;
                    }
                    try {
                        byte[] data = download(url, remote.optString("token", ""));
                        if (data.length < 12 || !new String(data, 0, 4).equals("RIFF")) {
                            remoteFailed++;
                            continue;
                        }
                        File written = writeExport(data, name);
                        if (written != null) uris.add(uriFor(written));
                    } catch (Exception e) {
                        remoteFailed++;
                    }
                }
                if (remotes.length() > 0 && remoteFailed == remotes.length() && uris.isEmpty()) {
                    call.reject("Could not download recording");
                    return;
                }
                if (uris.isEmpty()) {
                    call.reject("Missing file");
                    return;
                }
                getActivity()
                    .runOnUiThread(
                        () -> {
                            Intent send = new Intent(uris.size() == 1 ? Intent.ACTION_SEND : Intent.ACTION_SEND_MULTIPLE);
                            send.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);
                            if (uris.size() == 1) {
                                send.setType("*/*");
                                send.putExtra(Intent.EXTRA_STREAM, uris.get(0));
                            } else {
                                send.setType("*/*");
                                send.putParcelableArrayListExtra(Intent.EXTRA_STREAM, uris);
                            }
                            getActivity().startActivity(Intent.createChooser(send, "Save"));
                            call.resolve();
                        }
                    );
            } catch (Exception e) {
                call.reject(e.getMessage() != null ? e.getMessage() : "Could not save");
            }
        })
            .start();
    }

    @PluginMethod
    public void playSpeech(PluginCall call) {
        String b64 = call.getString("data");
        if (b64 == null || b64.isEmpty()) {
            call.reject("Missing audio");
            return;
        }
        byte[] data;
        try {
            data = Base64.decode(b64, Base64.DEFAULT);
        } catch (Exception e) {
            call.reject("Missing audio");
            return;
        }
        if (data.length == 0) {
            call.reject("Missing audio");
            return;
        }
        try {
            stopPlayer();
            File tmp = new File(getContext().getCacheDir(), "nod-speech.bin");
            FileOutputStream out = new FileOutputStream(tmp);
            out.write(data);
            out.close();
            player = new MediaPlayer();
            player.setDataSource(tmp.getAbsolutePath());
            player.setOnCompletionListener(mp -> stopPlayer());
            player.prepare();
            player.start();
            call.resolve();
        } catch (Exception e) {
            call.reject(e.getMessage() != null ? e.getMessage() : "Could not play");
        }
    }

    @PluginMethod
    public void stopSpeech(PluginCall call) {
        stopPlayer();
        call.resolve();
    }

    @PluginMethod
    public void storeAccount(PluginCall call) {
        SharedPreferences prefs = getContext().getSharedPreferences("nod.account", 0);
        prefs
            .edit()
            .putString("token", call.getString("token", ""))
            .putString("origin", call.getString("origin", ""))
            .apply();
        call.resolve();
    }

    @PluginMethod
    public void listSaves(PluginCall call) {
        JSObject out = new JSObject();
        out.put("saves", new JSArray());
        call.resolve(out);
    }

    @PluginMethod
    public void retrySave(PluginCall call) {
        call.resolve();
    }

    @PluginMethod
    public void resumeKeeps(PluginCall call) {
        call.resolve();
    }

    @PluginMethod
    public void discardSave(PluginCall call) {
        call.resolve();
    }

    private void stopPlayer() {
        if (player == null) return;
        try {
            player.stop();
        } catch (Exception ignored) {}
        player.release();
        player = null;
    }

    private File writeExport(byte[] data, String name) throws Exception {
        String safe = name.replace("/", "-");
        File cache = new File(getContext().getCacheDir(), "NodExport");
        if (!cache.isDirectory() && !cache.mkdirs()) {
            throw new IllegalStateException("Could not write export");
        }
        File file = new File(cache, safe);
        FileOutputStream out = new FileOutputStream(file);
        out.write(data);
        out.close();
        File docs = new File(getContext().getFilesDir(), "Recordings");
        //noinspection ResultOfMethodCallIgnored
        docs.mkdirs();
        File copy = new File(docs, safe);
        FileOutputStream copyOut = new FileOutputStream(copy);
        copyOut.write(data);
        copyOut.close();
        return file;
    }

    private Uri uriFor(File file) {
        return FileProvider.getUriForFile(getContext(), getContext().getPackageName() + ".fileprovider", file);
    }

    private static byte[] download(String urlStr, String token) throws Exception {
        HttpURLConnection conn = (HttpURLConnection) new URL(urlStr).openConnection();
        conn.setConnectTimeout(30_000);
        conn.setReadTimeout(120_000);
        if (token != null && !token.isEmpty()) {
            conn.setRequestProperty("Authorization", "Bearer " + token);
        }
        try (InputStream in = conn.getInputStream()) {
            java.io.ByteArrayOutputStream buf = new java.io.ByteArrayOutputStream();
            byte[] chunk = new byte[8192];
            int n;
            while ((n = in.read(chunk)) > 0) buf.write(chunk, 0, n);
            return buf.toByteArray();
        } finally {
            conn.disconnect();
        }
    }
}
