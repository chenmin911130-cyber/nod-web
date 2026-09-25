package app.nodpilot.plugins.mic;

/**
 * Phone → server send clock. Cumulative mode is never re-anchored on send completion.
 * Times are nanoseconds. No Android imports, so JVM unit tests can construct it.
 */
final class UplinkPacer {
    static final long SLACK_NANOS = 300_000_000L;

    String mode = "cumulative";
    double catchupRate = 1.0;
    int coalesceMax = 1;
    long nextSendAt;

    void reset() {
        nextSendAt = 0;
    }

    /** {@code stop()} cannot reassign a {@code final} field, so config returns here. */
    void restoreDefaults() {
        mode = "cumulative";
        catchupRate = 1.0;
        coalesceMax = 1;
        nextSendAt = 0;
    }

    long waitBeforeSendMs(long now) {
        if (nextSendAt <= 0) return 0;
        long wait = nextSendAt - now;
        if (wait <= 0) return 0;
        return (wait + 999_999L) / 1_000_000L;
    }

    int framesForMessage(int pending) {
        if (pending <= 0) return 0;
        if (!"cumulative".equals(mode) || pending < 2) return 1;
        return Math.min(pending, Math.max(1, coalesceMax));
    }

    void noteSendStarted(long now, long audioNanos, int pendingBefore) {
        if (!"cumulative".equals(mode)) return;
        long base = nextSendAt <= 0 ? now : Math.max(nextSendAt, now - SLACK_NANOS);
        double rate = pendingBefore >= 2 ? Math.max(1.0, catchupRate) : 1.0;
        nextSendAt = base + (long) (audioNanos / rate);
    }

    void noteSendCompleted(long now, long audioNanos) {
        if (!"legacy".equals(mode)) return;
        nextSendAt = now + audioNanos;
    }

    /** Null arguments leave the current value. Same clamps as the Swift pacer. */
    void applyConfig(String pace, Double rate, Integer coalesce) {
        if ("cumulative".equals(pace) || "legacy".equals(pace)) mode = pace;
        if (rate != null) catchupRate = Math.max(1.0, Math.min(2.0, rate));
        if (coalesce != null) coalesceMax = Math.max(1, Math.min(10, coalesce));
    }
}
