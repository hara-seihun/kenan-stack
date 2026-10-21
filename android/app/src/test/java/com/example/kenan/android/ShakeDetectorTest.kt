package com.example.kenan.android
import org.junit.Assert.*
import org.junit.Test
class ShakeDetectorTest {
    @Test fun rotationAndBumpDoNotTrigger() {
        val d = ShakeDetector()
        assertFalse(d.sample(1000000000L, 9.8f, 0f, 0f))
        assertFalse(d.sample(1100000000L, 0f, 0f, 30f))
        assertFalse(d.sample(1200000000L, 0f, 0f, 30f))
    }
    @Test fun releasedPeaksTriggerOnceThenCooldown() {
        val d = ShakeDetector()
        assertFalse(d.sample(1000000000L, 30f, 0f, 0f))
        assertFalse(d.sample(1100000000L, 0f, 0f, 9.8f))
        assertTrue(d.sample(1200000000L, -30f, 0f, 0f))
        d.sample(1300000000L, 0f, 0f, 9.8f)
        assertFalse(d.sample(1400000000L, 30f, 0f, 0f))
    }
    @Test fun pauseDiscardsIncompleteShake() {
        val d = ShakeDetector()
        d.sample(1000000000L, 30f, 0f, 0f); d.reset()
        assertFalse(d.sample(1200000000L, -30f, 0f, 0f))
    }
}
