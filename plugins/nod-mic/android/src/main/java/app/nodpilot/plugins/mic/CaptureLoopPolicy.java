package app.nodpilot.plugins.mic;

/** Screen-off listen: a dead AudioRecord must reopen until Stop, not exit the capture thread. */
final class CaptureLoopPolicy {

    static final long FOREGROUND_REFRESH_MS = 5_000L;

    private CaptureLoopPolicy() {}

    static boolean shouldReopenRecorder(boolean running, int bytesRead) {
        return running && bytesRead < 0;
    }

    static long reopenDelayMs(int failStreak) {
        int n = Math.max(1, failStreak);
        return Math.min(2_000L, 200L * n);
    }

    static boolean shouldRefreshForeground(long nowElapsedMs, long lastKickMs) {
        return nowElapsedMs - lastKickMs >= FOREGROUND_REFRESH_MS;
    }
}
