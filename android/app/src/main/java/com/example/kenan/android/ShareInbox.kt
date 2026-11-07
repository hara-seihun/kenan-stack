package com.example.kenan.android

import android.app.Activity
import android.content.Intent
import android.net.Uri
import android.provider.OpenableColumns
import android.webkit.MimeTypeMap
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.io.FileInputStream
import java.util.UUID
import java.util.concurrent.Executors

const val SHARE_ACTION = "kenan-share"
const val SHARE_PATH = "/__kenan-share/"

/** The server's per-message attachment limits (server/files/files.ts ATTACH_LIMITS). */
internal object ShareLimits { const val FILES = 10; const val FILE_BYTES = 50L * 1024 * 1024; const val TOTAL_BYTES = 100L * 1024 * 1024 }

internal sealed interface Copied {
    data class File(val bytes: Long) : Copied
    data object TooLarge : Copied
    data class Unreadable(val reason: String) : Copied
}

/** Room left for the next file after `used` bytes: the smaller of one file's limit and what the message has left. */
internal fun shareRoom(used: Long): Long = minOf(ShareLimits.FILE_BYTES, ShareLimits.TOTAL_BYTES - used)
/** Why a file longer than shareRoom(used) was left out. */
internal fun tooLarge(name: String?, used: Long): String =
    if (ShareLimits.TOTAL_BYTES - used < ShareLimits.FILE_BYTES) "${quoted(name).replaceFirstChar { it.uppercase() }} would make this message larger than 100 MB, so it was left out."
    else "${quoted(name).replaceFirstChar { it.uppercase() }} is larger than 50 MB, the most one file can be."

internal fun quoted(name: String?) = name?.let { "“$it”" } ?: "one of the files"
/** A file the sending app didn't name: "Shared file", with the extension its type implies. */
internal fun unnamed(mime: String) = "Shared file" + (MimeTypeMap.getSingleton().getExtensionFromMimeType(mime)?.let { ".$it" } ?: "")

/** Shared words for the composer: a subject (Chrome's page title) goes above the text unless the text already has it. */
internal fun sharedText(subject: String?, text: String?): String? {
    val words = text?.trim()?.takeIf { it.isNotEmpty() }
    val title = subject?.trim()?.takeIf { it.isNotEmpty() && words?.contains(it) != true }
    return listOfNotNull(title, words).joinToString("\n").takeIf { it.isNotEmpty() }
}

internal data class SharedFile(val name: String, val mime: String, val size: Long)
internal data class Share(val id: String, val files: List<SharedFile>, val text: String?, val problems: List<String>) {
    fun json(origin: String) = JSONObject().put("id", id).put("text", text ?: JSONObject.NULL)
        .put("problems", JSONArray(problems))
        .put("files", JSONArray(files.mapIndexed { index, f -> JSONObject().put("url", "$origin$SHARE_PATH$id/$index").put("name", f.name).put("mime", f.mime).put("size", f.size) }))
}

/**
 * What another app shared to Kenan (Android's share sheet → ShareActivity → this activity). The bytes are copied into
 * the app's cache at once, while the sender's read grant lasts; the page takes the share once (bridge takeShare) and
 * reads each file from SHARE_PATH, which the WebView serves from that copy, then uploads it like any attachment.
 */
internal class ShareInbox(private val activity: Activity) {
    private sealed interface State {
        data object Empty : State
        data class Copying(val id: String, val waiting: MutableList<Pair<String, (Outcome<JSONObject>) -> Unit>>) : State
        data class Ready(val share: Share) : State
    }
    private var state: State = State.Empty
    @Volatile private var served: Share? = null
    private val work = Executors.newSingleThreadExecutor()
    private val root get() = File(activity.cacheDir, "share")

    /** Starts copying a forwarded share; false for any other intent. The newest share replaces one not yet taken. */
    fun receive(intent: Intent?): Boolean {
        if (intent?.action != SHARE_ACTION) return false
        val id = UUID.randomUUID().toString()
        val previous = state
        val sources = sources(intent)
        val text = sharedText(intent.getStringExtra(Intent.EXTRA_SUBJECT), intent.getCharSequenceExtra(Intent.EXTRA_TEXT)?.toString())
        state = State.Copying(id, if (previous is State.Copying) previous.waiting else mutableListOf())
        work.execute {
            val share = try { copy(id, sources, text) } catch (e: Exception) { Share(id, emptyList(), text, listOf("Couldn't prepare what you shared: ${e.message ?: e.javaClass.simpleName}")) }
            activity.runOnUiThread { arrived(share) }
        }
        return true
    }

    /** Hands the page the share once, after its copy finished; `share` is null when nothing was shared. */
    fun take(origin: String, reply: (Outcome<JSONObject>) -> Unit) {
        when (val current = state) {
            State.Empty -> reply(Outcome.Ok(JSONObject().put("share", JSONObject.NULL)))
            is State.Copying -> current.waiting += origin to reply
            is State.Ready -> { state = State.Empty; served = current.share; reply(Outcome.Ok(JSONObject().put("share", current.share.json(origin)))) }
        }
    }

    /** Serves a taken share's file to the page; any other share path is 404. Runs on WebView's network thread. */
    fun response(request: WebResourceRequest, origin: String): WebResourceResponse? {
        val url = request.url.toString()
        if (request.method != "GET" || !url.startsWith(origin + SHARE_PATH)) return null
        val share = served
        val parts = url.removePrefix(origin + SHARE_PATH).split('/')
        val index = parts.getOrNull(1)?.toIntOrNull()
        val file = if (share == null || parts.size != 2 || parts[0] != share.id || index == null) null else share.files.getOrNull(index)
        if (share == null || file == null) return WebResourceResponse("text/plain", "utf-8", 404, "Not Found", mapOf("cache-control" to "no-store"), "".byteInputStream())
        return WebResourceResponse(file.mime.ifEmpty { "application/octet-stream" }, null, 200, "OK",
            mapOf("content-length" to file.size.toString(), "cache-control" to "no-store"), FileInputStream(File(root, "${share.id}/$index")))
    }

    fun close() = work.shutdown()

    private fun arrived(share: Share) {
        val current = state
        if (current !is State.Copying || current.id != share.id) { File(root, share.id).deleteRecursively(); return }
        val waiting = current.waiting.toList()
        if (waiting.isEmpty()) { state = State.Ready(share); return }
        state = State.Empty; served = share
        waiting.forEach { (origin, reply) -> reply(Outcome.Ok(JSONObject().put("share", share.json(origin)))) }
    }

    /** ShareActivity forwards the shared files as clipData, which carries their read grant. */
    private fun sources(intent: Intent): List<Uri> = intent.clipData?.let { c -> (0 until c.itemCount).mapNotNull { c.getItemAt(it).uri } } ?: emptyList()

    private fun copy(id: String, sources: List<Uri>, text: String?): Share {
        root.listFiles()?.forEach { if (it.name != id && it.name != served?.id) it.deleteRecursively() }
        val dir = File(root, id).apply { mkdirs() }
        val files = mutableListOf<SharedFile>(); val problems = mutableListOf<String>()
        var used = 0L
        for (uri in sources) {
            if (files.size == ShareLimits.FILES) { problems += "Only ${ShareLimits.FILES} files fit in one message, so ${sources.size - sources.indexOf(uri)} were left out."; break }
            val name = displayName(uri)
            val target = File(dir, files.size.toString())
            when (val copied = read(uri, target, shareRoom(used))) {
                is Copied.File -> { used += copied.bytes; val type = mime(uri, name); files += SharedFile(name ?: unnamed(type), type, copied.bytes) }
                Copied.TooLarge -> { target.delete(); problems += tooLarge(name, used) }
                is Copied.Unreadable -> { target.delete(); problems += "Couldn't read ${quoted(name)}: ${copied.reason}." }
            }
        }
        return Share(id, files, text, problems)
    }

    /** Copies at most `room` bytes; a source that is longer is refused rather than cut. */
    private fun read(uri: Uri, target: File, room: Long): Copied {
        if (uri.scheme != "content") return Copied.Unreadable("the app shared it in a way Android no longer allows (${uri.scheme})")
        val owner = uri.authority?.let { activity.packageManager.resolveContentProvider(it, 0)?.applicationInfo?.uid }
        if (owner == activity.applicationInfo.uid) return Copied.Unreadable("it is one of Kenan's own private files")
        return try {
            val input = activity.contentResolver.openInputStream(uri) ?: return Copied.Unreadable("the app gave no content")
            input.use { source -> target.outputStream().use { sink ->
                val buffer = ByteArray(64 * 1024); var total = 0L
                while (true) {
                    val n = source.read(buffer); if (n < 0) break
                    total += n; if (total > room) return Copied.TooLarge
                    sink.write(buffer, 0, n)
                }
                Copied.File(total)
            } }
        } catch (e: SecurityException) { Copied.Unreadable("Android didn't give Kenan permission to read it") }
        catch (e: Exception) { Copied.Unreadable(e.message ?: e.javaClass.simpleName) }
    }

    /** The name the sending app gives the file; null when it gives none or won't say. */
    private fun displayName(uri: Uri): String? = try {
        activity.contentResolver.query(uri, arrayOf(OpenableColumns.DISPLAY_NAME), null, null, null)?.use { c -> if (c.moveToFirst() && !c.isNull(0)) c.getString(0) else null }
    } catch (e: Exception) { null }?.trim()?.takeIf { it.isNotEmpty() }

    private fun mime(uri: Uri, name: String?): String = try { activity.contentResolver.getType(uri) } catch (e: Exception) { null }?.takeIf { '*' !in it }
        ?: name?.let { MimeTypeMap.getSingleton().getMimeTypeFromExtension(it.substringAfterLast('.', "").lowercase()) }
        ?: ""
}
