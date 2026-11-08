package com.example.kenan.android

/** Three hard acceleration peaks, each released, within 1.5 seconds open settings. */
internal class ShakeDetector {
    private var first = 0L
    private var last = 0L
    private var peaks = 0
    private var high = false
    private var cooldown = 0L
    fun reset() { first = 0L; last = 0L; peaks = 0; high = false }
    fun sample(now: Long, x: Float, y: Float, z: Float): Boolean {
        if (peaks > 0 && now - first > 1500000000L) { first = 0L; last = 0L; peaks = 0 }
        val g2 = (x * x + y * y + z * z) / (9.80665f * 9.80665f)
        if (g2 < 1.8f * 1.8f) { high = false; return false }
        if (g2 < 5.4f * 5.4f || high || now < cooldown) return false
        high = true
        // Count separate shakes, not samples from one impact or its immediate rebound.
        if (peaks > 0 && now - last < 150000000L) return false
        if (peaks == 0) first = now
        last = now
        peaks++
        if (peaks < 3) return false
        reset(); cooldown = now + 1500000000L
        return true
    }
}
