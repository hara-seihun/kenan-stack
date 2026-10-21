package com.example.kenan.android

/** Two acceleration peaks separated by a release; rotation and single bumps do not open settings. */
internal class ShakeDetector {
    private var first = 0L
    private var high = false
    private var cooldown = 0L
    fun reset() { first = 0L; high = false }
    fun sample(now: Long, x: Float, y: Float, z: Float): Boolean {
        val g2 = (x * x + y * y + z * z) / (9.80665f * 9.80665f)
        if (g2 < 1.8f * 1.8f) { high = false; return false }
        if (g2 < 2.7f * 2.7f || high || now < cooldown) return false
        high = true
        if (first != 0L && now - first in 80000000L..800000000L) {
            first = 0L; cooldown = now + 1500000000L; return true
        }
        first = now
        return false
    }
}
