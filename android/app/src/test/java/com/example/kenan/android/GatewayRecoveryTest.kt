package com.example.kenan.android

import org.junit.Assert.*
import org.junit.Test

class GatewayRecoveryTest {
    @Test fun everyOutageRetainsABoundedAutomaticRetry() {
        for (failure in listOf(Int.MIN_VALUE, -1, 0, 1, 2, 3, 100, Int.MAX_VALUE)) {
            val delay = gatewayRetryDelay(failure)
            assertTrue(delay in 500L..2000L)
        }
        assertEquals(500L, gatewayRetryDelay(1))
        assertEquals(1000L, gatewayRetryDelay(2))
        assertEquals(2000L, gatewayRetryDelay(3))
    }
}
