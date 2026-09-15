package app.nodpilot.plugins.mic;

import org.junit.Test;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

public class CaptureLoopPolicyTest {

    @Test
    public void deadReadWhileListeningReopens() {
        assertTrue(CaptureLoopPolicy.shouldReopenRecorder(true, AudioRecordError.ERROR_DEAD_OBJECT));
        assertTrue(CaptureLoopPolicy.shouldReopenRecorder(true, -1));
    }

    @Test
    public void stopDoesNotReopenADeadRead() {
        assertFalse(CaptureLoopPolicy.shouldReopenRecorder(false, -1));
    }

    @Test
    public void aLiveReadDoesNotReopen() {
        assertFalse(CaptureLoopPolicy.shouldReopenRecorder(true, 3200));
        assertFalse(CaptureLoopPolicy.shouldReopenRecorder(true, 0));
    }

    @Test
    public void reopenBackoffCapsAtTwoSeconds() {
        assertEquals(200L, CaptureLoopPolicy.reopenDelayMs(1));
        assertEquals(200L, CaptureLoopPolicy.reopenDelayMs(0));
        assertEquals(2_000L, CaptureLoopPolicy.reopenDelayMs(10));
    }

    @Test
    public void foregroundRefreshIsEveryFiveSeconds() {
        assertTrue(CaptureLoopPolicy.shouldRefreshForeground(5_000L, 0L));
        assertFalse(CaptureLoopPolicy.shouldRefreshForeground(4_999L, 0L));
    }

    /** Mirrors android.media.AudioRecord.ERROR_DEAD_OBJECT without pulling the Android SDK into this unit test. */
    private static final class AudioRecordError {
        static final int ERROR_DEAD_OBJECT = -6;
    }
}
