package com.example.kenan.android

import org.junit.Assert.*
import org.junit.Test

class NativeRecoveryTest {
    @Test fun throwingPlatformObservationBecomesRetryableOutcome() {
        assertTrue(nativeAttempt<Unit> { throw IllegalStateException("fixture") } is Outcome.Err)
        assertEquals(Outcome.Ok("recovered"), nativeAttempt { Outcome.Ok("recovered") })
    }
    @Test fun reportingFailureCannotPreventTheNextObservation() {
        var scheduled = 0
        val result = finishNativeAttempt({ scheduled++ }, { throw IllegalStateException("report failed") })
        assertEquals(1, scheduled)
        assertTrue(result is Outcome.Err)
    }
}
