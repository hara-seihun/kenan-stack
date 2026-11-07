package com.example.kenan.android

import java.util.concurrent.Executors
import java.util.concurrent.ScheduledExecutorService
import java.util.concurrent.ScheduledFuture
import java.util.concurrent.TimeUnit

/** UI calls only update memory. Immutable keys retain the original owner/conversation. */
class DraftPersistence(
    private val save: (String, String) -> Boolean,
    private val failed: () -> Unit,
    private val worker: ScheduledExecutorService = sharedWorker,
    private val delayMillis: Long = 150
) {
    companion object { private val sharedWorker = Executors.newSingleThreadScheduledExecutor() }
    private data class Draft(val text: String)
    private val latest = mutableMapOf<String, Draft>()
    private val scheduled = mutableMapOf<String, ScheduledFuture<*>>()
    @Synchronized fun text(key: String, fallback: () -> String): String = latest[key]?.text ?: fallback()
    @Synchronized fun changed(key: String, text: String) {
        latest[key] = Draft(text)
        enqueue(key, delayMillis)
    }
    /** Schedule immediately on hide/send/scope change; never wait for disk on the UI thread. */
    @Synchronized fun flush() { latest.keys.toList().forEach { enqueue(it, 0) } }
    private fun enqueue(key: String, delay: Long) {
        scheduled.remove(key)?.cancel(false)
        scheduled[key] = worker.schedule({ persist(key) }, delay, TimeUnit.MILLISECONDS)
    }
    private fun persist(key: String) {
        val draft = synchronized(this) { latest[key] } ?: return
        val saved = try { save(key, draft.text) } catch (_: Exception) { false }
        synchronized(this) { if (saved && latest[key] === draft) latest.remove(key) }
        if (!saved) {
            synchronized(this) { if (latest[key] === draft) enqueue(key, 1000) }
            failed()
        }
    }
}
