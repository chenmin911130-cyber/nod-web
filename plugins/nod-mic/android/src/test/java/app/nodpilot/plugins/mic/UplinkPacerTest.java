package app.nodpilot.plugins.mic;

import org.junit.Test;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertTrue;

/** Same cases as the iOS pacer suite. The Handler overhead stand-in is 2 ms. */
public class UplinkPacerTest {
    private static final long MS = 1_000_000L;
    private static final long FRAME = 100_000_000L;

    @Test
    public void legacyReproducesDrift() {
        UplinkPacer pacer = new UplinkPacer();
        pacer.mode = "legacy";
        long now = 0;
        long first = 0;
        long last = 0;
        for (int i = 0; i < 600; i++) {
            long start = now + pacer.waitBeforeSendMs(now) * MS;
            if (i == 0) first = start;
            if (i == 599) last = start;
            long complete = start + 2 * MS;
            pacer.noteSendCompleted(complete, FRAME);
            now = complete;
        }
        double elapsed = (last - first) / 1e9;
        System.out.printf("legacy 600 sends: %.4f s%n", elapsed);
        assertTrue("legacy drift " + elapsed, elapsed >= 61.0);
    }

    @Test
    public void legacyMatchesBaselineFormula() {
        long[][] triples = {
            {0, FRAME, 40 * MS},
            {1_000_000_000L, FRAME, 1_050_000_000L},
            {2_500_000_000L, FRAME, 2_700_000_000L},
            {10_000_000_000L, 200_000_000L, 10_050_000_000L},
            {10_000_000_000L, 200_000_000L, 10_250_000_000L},
            {3_000_000_000L, 50_000_000L, 3_000_000_000L},
            {4_000_000_000L, FRAME, 3_900_000_000L},
            {8_000_000_000L, 150_000_000L, 8_200_000_000L},
            {0, 0, 1_000_000_000L},
            {5_000_000_000L, FRAME, 5_100_000_000L},
            {6_400_000_000L, FRAME, 6_403_000_000L},
            {7_000_000_000L, 320_000_000L, 7_100_000_000L},
            {9_000_000_000L, FRAME, 9_099_000_000L},
            {12_000_000_000L, 50_000_000L, 12_040_000_000L},
            {15_000_000_000L, FRAME, 14_950_000_000L},
            {20_000_000_000L, 200_000_000L, 20_300_000_000L},
            {30_000_000_000L, FRAME, 30_006_400_000L},
            {40_000_000_000L, 3_000_000L, 40_002_000_000L},
            {50_000_000_000L, FRAME, 50_103_000_000L},
            {100_000_000_000L, FRAME, 99_500_000_000L},
        };
        assertEquals(20, triples.length);
        for (long[] row : triples) {
            UplinkPacer pacer = new UplinkPacer();
            pacer.mode = "legacy";
            pacer.noteSendCompleted(row[0], row[1]);
            long got = pacer.waitBeforeSendMs(row[2]);
            long expectNanos = Math.max(0, row[1] - (row[2] - row[0]));
            long want = expectNanos <= 0 ? 0 : (expectNanos + 999_999L) / MS;
            assertEquals(want, got);
        }
    }

    @Test
    public void cumulativeNoDrift() {
        UplinkPacer pacer = new UplinkPacer();
        long now = 0;
        long first = 0;
        long last = 0;
        for (int i = 0; i < 600; i++) {
            long start = now + pacer.waitBeforeSendMs(now) * MS;
            if (i == 0) first = start;
            if (i == 599) last = start;
            pacer.noteSendStarted(start, FRAME, 1);
            long complete = start + 2 * MS;
            pacer.noteSendCompleted(complete, FRAME);
            now = complete;
        }
        double elapsed = (last - first) / 1e9;
        System.out.printf("cumulative 600 sends: %.4f s%n", elapsed);
        assertTrue("cumulative " + elapsed, Math.abs(elapsed - 59.9) <= 0.05);
    }

    @Test
    public void catchupDrainsBacklogBounded() {
        UplinkPacer pacer = new UplinkPacer();
        pacer.catchupRate = 1.5;
        pacer.coalesceMax = 3;
        int pending = 50;
        long t = 0;
        long nextArrival = 100 * MS;
        int messages = 0;
        int maxFrames = 0;
        long[] startAt = new long[200];
        int[] frames = new int[200];
        while (t < 30_000_000_000L && pending > 1 && messages < startAt.length) {
            long target = t + pacer.waitBeforeSendMs(t) * MS;
            while (nextArrival <= target) {
                pending++;
                nextArrival += 100 * MS;
            }
            t = target;
            if (pending <= 1) break;
            int n = pacer.framesForMessage(pending);
            pacer.noteSendStarted(t, n * FRAME, pending);
            pending -= n;
            startAt[messages] = t;
            frames[messages] = n;
            maxFrames = Math.max(maxFrames, n);
            messages++;
            if (pending <= 1) break;
        }
        assertTrue("drain t=" + (t / 1e9), t <= 11_000_000_000L);
        assertTrue("frames " + maxFrames, maxFrames <= 3);
        int worstMessages = 0;
        double worstAudio = 0;
        for (int i = 0; i < messages; i++) {
            int count = 0;
            double audio = 0;
            for (int j = 0; j < messages; j++) {
                if (startAt[j] >= startAt[i] && startAt[j] < startAt[i] + 1_000_000_000L) {
                    count++;
                    audio += frames[j] * 0.1;
                }
            }
            worstMessages = Math.max(worstMessages, count);
            worstAudio = Math.max(worstAudio, audio);
        }
        assertTrue("msgs/s " + worstMessages, worstMessages <= 10);
        assertTrue("audio/s " + worstAudio, worstAudio <= 2.1);
        System.out.printf("catch-up drain: %.3f s, worst %d msgs/s, %.3f audio-s/s%n", t / 1e9, worstMessages, worstAudio);
    }

    @Test
    public void noCatchupWhenRateOne() {
        UplinkPacer pacer = new UplinkPacer();
        pacer.catchupRate = 1.0;
        pacer.coalesceMax = 1;
        int pending = 50;
        long t = 0;
        long nextArrival = 100 * MS;
        int minPending = pending;
        long horizon = 10_000_000_000L;
        while (t < horizon) {
            long target = t + pacer.waitBeforeSendMs(t) * MS;
            while (nextArrival <= Math.min(target, horizon)) {
                pending++;
                nextArrival += 100 * MS;
                minPending = Math.min(minPending, pending);
            }
            if (target > horizon) break;
            t = target;
            int n = pacer.framesForMessage(pending);
            pacer.noteSendStarted(t, n * FRAME, pending);
            pending -= n;
            minPending = Math.min(minPending, pending);
        }
        assertTrue("min pending " + minPending, minPending >= 49);
    }

    @Test
    public void slackBoundsBurst() {
        UplinkPacer pacer = new UplinkPacer();
        pacer.catchupRate = 1.5;
        pacer.coalesceMax = 3;
        pacer.nextSendAt = 10_000_000_000L;
        long now = 20_000_000_000L;
        int pending = 30;
        int zeroRun = 0;
        int maxZero = 0;
        int steps = 0;
        while (pending > 1 && steps < 40) {
            long wait = pacer.waitBeforeSendMs(now);
            if (wait == 0) {
                zeroRun++;
                maxZero = Math.max(maxZero, zeroRun);
            } else {
                zeroRun = 0;
            }
            now += wait * MS;
            int n = pacer.framesForMessage(pending);
            pacer.noteSendStarted(now, n * FRAME, pending);
            pending -= n;
            steps++;
        }
        assertTrue("zero run " + maxZero, maxZero >= 1 && maxZero <= 3);
    }

    @Test
    public void framesForMessageCases() {
        UplinkPacer legacy = new UplinkPacer();
        legacy.mode = "legacy";
        legacy.coalesceMax = 3;
        assertEquals(0, legacy.framesForMessage(0));
        assertEquals(1, legacy.framesForMessage(1));
        assertEquals(1, legacy.framesForMessage(5));

        UplinkPacer cumulative = new UplinkPacer();
        cumulative.coalesceMax = 3;
        assertEquals(0, cumulative.framesForMessage(0));
        assertEquals(1, cumulative.framesForMessage(1));
        assertEquals(2, cumulative.framesForMessage(2));
        assertEquals(3, cumulative.framesForMessage(5));
        cumulative.coalesceMax = 1;
        assertEquals(1, cumulative.framesForMessage(5));
    }

    @Test
    public void applyConfigClamps() {
        UplinkPacer pacer = new UplinkPacer();
        pacer.catchupRate = 1.25;
        pacer.coalesceMax = 4;
        pacer.applyConfig(null, 9.0, null);
        assertEquals(2.0, pacer.catchupRate, 0);
        pacer.applyConfig(null, 0.5, null);
        assertEquals(1.0, pacer.catchupRate, 0);
        pacer.applyConfig(null, null, 0);
        assertEquals(1, pacer.coalesceMax);
        pacer.applyConfig(null, null, 50);
        assertEquals(10, pacer.coalesceMax);
        pacer.applyConfig("legacy", null, null);
        assertEquals("legacy", pacer.mode);
        pacer.applyConfig("cumulative", null, null);
        assertEquals("cumulative", pacer.mode);
        pacer.applyConfig("bogus", null, null);
        assertEquals("cumulative", pacer.mode);
        pacer.catchupRate = 1.7;
        pacer.coalesceMax = 4;
        pacer.applyConfig(null, null, null);
        assertEquals(1.7, pacer.catchupRate, 0);
        assertEquals(4, pacer.coalesceMax);
        assertEquals("cumulative", pacer.mode);
    }
}
