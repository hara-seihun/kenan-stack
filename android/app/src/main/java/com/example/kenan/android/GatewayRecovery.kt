package com.example.kenan.android

/** A failed document never ends the enabled view's recovery responsibility.
 * Integer saturation also keeps a sufficiently long outage from overflowing. */
fun gatewayRetryDelay(failures: Int): Long = 500L shl (failures.coerceAtLeast(1) - 1).coerceAtMost(2)
