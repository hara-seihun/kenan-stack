package com.example.kenan.android

import android.content.Context
import android.net.Uri
import okhttp3.Call
import okhttp3.OkHttpClient
import okhttp3.Request
import org.json.JSONObject
import java.util.concurrent.TimeUnit

class GatewayDownload(private val context: Context) : AutoCloseable {
    data class Source(val url: String, val origin: String, val cookies: String, val fileName: String, val generation: Int)
    private val client = OkHttpClient.Builder().followRedirects(false).readTimeout(60, TimeUnit.SECONDS).build()
    private val generation = java.util.concurrent.atomic.AtomicInteger(0)
    @Volatile private var call: Call? = null
    @Volatile private var closed = false
    fun source(url: String, origin: String, cookies: String, disposition: String): Outcome<Source> = try {
        val uri = java.net.URI(url)
        val parsed = Gateway.parse("${uri.scheme}://${uri.rawAuthority}")
        require(parsed is Outcome.Ok && parsed.value.origin == origin && uri.rawUserInfo == null && uri.rawFragment == null)
        when (val name = downloadName(disposition)) {
            is Outcome.Err -> name
            is Outcome.Ok -> Outcome.Ok(Source(url, origin, cookies, name.value, generation.get()))
        }
    } catch (e: Exception) { Outcome.Err("invalid_input", "Downloads must come from the authenticated gateway origin") }
    fun save(source: Source, destination: Uri): Outcome<JSONObject> = boundary {
        require(!closed && source.generation == generation.get()) { "Download owner is closed or session changed" }
        val current = client.newCall(Request.Builder().url(source.url).header("Cookie", source.cookies).build()); call = current
        try {
            require(!closed && source.generation == generation.get()) { "Download session changed" }
            current.execute().use { response ->
                require(response.code == 200) { "Download rejected (${response.code}); redirects are not followed" }
                val body = response.body ?: throw IllegalArgumentException("Download has no body")
                val output = context.contentResolver.openOutputStream(destination, "w") ?: throw IllegalStateException("Android document provider unavailable")
                var bytes = 0L
                output.use { target -> body.byteStream().use { input ->
                    val chunk = ByteArray(65536)
                    while (true) {
                        require(!closed && source.generation == generation.get()) { "Download session changed during transfer" }
                        val read = input.read(chunk); if (read == -1) break
                        bytes += read
                        target.write(chunk, 0, read)
                    }
                } }
                JSONObject().put("savedBytes", bytes)
            }
        } finally { call = null }
    }
    fun cancel() { generation.incrementAndGet(); call?.cancel() }
    override fun close() { closed = true; cancel(); client.dispatcher.executorService.shutdown(); client.connectionPool.evictAll() }
}
