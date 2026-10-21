package com.example.kenan.android

/** Foreign Android calls can throw despite their documented return contract. The
 * caller retains the original operation and schedules its next observation. */
internal fun <T> nativeAttempt(action: () -> Outcome<T>): Outcome<T> = try { action() }
catch (error: Exception) { Outcome.Err("platform_failure", error.javaClass.simpleName) }

/** Establish continuation before optional reporting, which itself may fail. */
internal fun finishNativeAttempt(schedule: () -> Unit, report: () -> Unit): Outcome<Unit> {
    schedule()
    return nativeAttempt { report(); Outcome.Ok(Unit) }
}
