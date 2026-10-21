package com.example.kenan.android

import java.util.concurrent.CountDownLatch
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit
import org.junit.Assert.*
import org.junit.Test

class DraftPersistenceTest {
    @Test fun failedDraftRetriesWithoutAnotherKeystrokeOrFlush() {
        val worker = Executors.newSingleThreadScheduledExecutor()
        val recovered = CountDownLatch(1)
        var attempts = 0
        val drafts = DraftPersistence({ _, value ->
            attempts++
            if (attempts == 1) throw IllegalStateException("Temporary storage error")
            assertEquals("retained exact draft", value); recovered.countDown(); true
        }, {}, worker, 1)
        try {
            drafts.changed("alice:one", "retained exact draft")
            assertTrue(recovered.await(3, TimeUnit.SECONDS))
            assertEquals(2, attempts)
        } finally { worker.shutdownNow() }
    }

    @Test fun slowDiskDoesNotBlockTypingAndLatestEditWins() {
        val worker = Executors.newSingleThreadScheduledExecutor()
        val entered = CountDownLatch(1); val release = CountDownLatch(1)
        val saved = mutableListOf<Pair<String, String>>()
        val drafts = DraftPersistence({ key, value -> entered.countDown(); release.await(); saved.add(key to value); true }, { fail("Unexpected save failure") }, worker, 60_000)
        try {
            drafts.changed("owner:conversation", "first"); drafts.flush()
            assertTrue(entered.await(2, TimeUnit.SECONDS))
            // These calls must complete while persistence is still deliberately blocked.
            repeat(100) { drafts.changed("owner:conversation", "edit-$it") }
            assertEquals("edit-99", drafts.text("owner:conversation") { "disk" })
            drafts.flush(); release.countDown()
            worker.submit {}.get(2, TimeUnit.SECONDS)
            assertEquals(listOf("owner:conversation" to "first", "owner:conversation" to "edit-99"), saved)
        } finally { release.countDown(); worker.shutdownNow() }
    }
    @Test fun closeFlushPreservesOriginalScopeAndFailedDraftRemainsAvailable() {
        val worker = Executors.newSingleThreadScheduledExecutor()
        val saved = mutableMapOf<String, String>(); var failSave = true; var failures = 0
        val drafts = DraftPersistence({ key, value -> if (failSave) false else { saved[key] = value; true } }, { failures++ }, worker, 60_000)
        try {
            drafts.changed("alice:one", "Alice draft"); drafts.flush(); worker.submit {}.get(2, TimeUnit.SECONDS)
            assertEquals(1, failures)
            assertEquals("Alice draft", drafts.text("alice:one") { "" })
            failSave = false
            drafts.changed("bob:two", "Bob draft"); drafts.flush(); worker.submit {}.get(2, TimeUnit.SECONDS)
            assertEquals(mapOf("alice:one" to "Alice draft", "bob:two" to "Bob draft"), saved)
            assertEquals("unrelated", drafts.text("bob:one") { "unrelated" })
        } finally { worker.shutdownNow() }
    }
}
