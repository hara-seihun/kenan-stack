package com.example.kenan.android

import android.Manifest
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.os.Handler
import android.os.Looper
import android.provider.Telephony
import android.webkit.CookieManager
import androidx.core.app.NotificationManagerCompat
import androidx.core.content.ContextCompat
import okhttp3.Call
import okhttp3.Callback
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import okhttp3.Response
import org.json.JSONArray
import org.json.JSONObject
import java.io.IOException
import java.security.MessageDigest
import java.util.concurrent.TimeUnit

/** Forwards texts arriving on this phone to the person's agents (POST /api/ext/texts). Held in a queue until the server keeps them. */
object Texts {
    data class Text(val id: String, val source: String, val app: String, val sender: String, val body: String, val at: Long) {
        fun json(): JSONObject = JSONObject().put("id", id).put("source", source).put("app", app).put("sender", sender).put("body", body).put("at", at)
    }
    /** What the server said about texts for the signed-in person; Unknown until it has answered once. */
    enum class Server { Unknown, Enabled, Disabled }

    private const val PREFS = "kenan-texts"
    private const val PENDING = "pending"
    private const val SERVER = "server"
    private const val MAX_PENDING = 500
    private const val SYNC_MS = 24 * 3600_000L
    private val main = Handler(Looper.getMainLooper())
    private val client = OkHttpClient.Builder().connectTimeout(20, TimeUnit.SECONDS).readTimeout(30, TimeUnit.SECONDS).build()
    private var inFlight = false
    private var again = false
    /** Called on the main thread when the server's answer changes, so setup can offer the texts steps. */
    var serverChanged: ((Server) -> Unit)? = null

    fun id(source: String, app: String, sender: String, at: Long, body: String): String =
        source + ":" + MessageDigest.getInstance("SHA-256").digest("$app\u0000$sender\u0000$at\u0000$body".toByteArray()).joinToString("") { "%02x".format(it) }.take(32)

    private fun prefs(context: Context) = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
    fun server(context: Context): Server = when (val value = prefs(context).getString(SERVER, null)) {
        null -> Server.Unknown
        else -> Server.valueOf(value)
    }
    fun smsGranted(context: Context) = listOf(Manifest.permission.RECEIVE_SMS, Manifest.permission.READ_SMS).all { ContextCompat.checkSelfPermission(context, it) == PackageManager.PERMISSION_GRANTED }
    fun notificationAccess(context: Context) = context.packageName in NotificationManagerCompat.getEnabledListenerPackages(context)

    /** Queues texts and sends them now. Main thread. */
    fun submit(context: Context, texts: List<Text>) {
        val prefs = prefs(context)
        val pending = JSONArray(prefs.getString(PENDING, "[]"))
        val known = (0 until pending.length()).map { pending.getJSONObject(it).getString("id") }.toMutableSet()
        texts.filter { known.add(it.id) }.forEach { pending.put(it.json()) }
        val kept = JSONArray((maxOf(0, pending.length() - MAX_PENDING) until pending.length()).map { pending.getJSONObject(it) })
        check(prefs.edit().putString(PENDING, kept.toString()).commit()) { "Text queue was not saved" }
        flush(context.applicationContext)
    }

    /** Queues the last day of the SMS inbox (texts that came while the app couldn't receive them), then sends. Main thread. */
    fun sync(context: Context) {
        if (!smsGranted(context)) { flush(context.applicationContext); return }
        val app = Telephony.Sms.getDefaultSmsPackage(context) ?: "sms"
        val texts = mutableListOf<Text>()
        context.contentResolver.query(Telephony.Sms.Inbox.CONTENT_URI, arrayOf("address", "body", "date", "date_sent"),
            "date > ?", arrayOf((System.currentTimeMillis() - SYNC_MS).toString()), "date ASC")?.use { c ->
            while (c.moveToNext()) {
                val address = c.getString(0) ?: continue; val body = c.getString(1)?.takeIf { it.isNotBlank() } ?: continue
                texts.add(Text(id("sms", "sms", address, c.getLong(3), body), "sms", app, address, body, c.getLong(2)))
            }
        }
        submit(context, texts)
    }

    /** Sends everything queued; an empty send still learns whether the server keeps texts for this person. Main thread. */
    fun flush(context: Context) {
        if (inFlight) { again = true; return }
        val cookies = CookieManager.getInstance().getCookie(BETA_ORIGIN) ?: return
        val batch = JSONArray(prefs(context).getString(PENDING, "[]"))
        inFlight = true; again = false
        val request = Request.Builder().url("$BETA_ORIGIN/api/ext/texts").header("Cookie", cookies).header("x-kenan-client", "native")
            .post(JSONObject().put("texts", batch).toString().toRequestBody("application/json".toMediaType())).build()
        client.newCall(request).enqueue(object : Callback {
            override fun onFailure(call: Call, e: IOException) { main.post { done(context, batch, null) } }
            override fun onResponse(call: Call, response: Response) { val code = response.use { it.code }; main.post { done(context, batch, code) } }
        })
    }

    private fun done(context: Context, batch: JSONArray, code: Int?) {
        inFlight = false
        val answer = when (code) { 200 -> Server.Enabled; 403 -> Server.Disabled; else -> null }
        if (answer != null) {
            val prefs = prefs(context)
            val sent = (0 until batch.length()).map { batch.getJSONObject(it).getString("id") }.toSet()
            val pending = JSONArray(prefs.getString(PENDING, "[]"))
            val left = JSONArray((0 until pending.length()).map { pending.getJSONObject(it) }.filter { it.getString("id") !in sent })
            val changed = server(context) != answer
            check(prefs.edit().putString(PENDING, left.toString()).putString(SERVER, answer.name).commit()) { "Text queue was not saved" }
            if (changed) serverChanged?.invoke(answer)
            if (again || (answer == Server.Enabled && left.length() > 0)) flush(context)
        }
        // Network and server errors keep the queue; the next text or notification-stream connect sends it.
    }
}

/** Incoming SMS, the moment the phone receives it. */
class SmsReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        if (intent.action != Telephony.Sms.Intents.SMS_RECEIVED_ACTION) return
        val parts = Telephony.Sms.Intents.getMessagesFromIntent(intent) ?: return
        val app = Telephony.Sms.getDefaultSmsPackage(context) ?: "sms"
        val now = System.currentTimeMillis()
        val texts = parts.filter { it.originatingAddress != null }.groupBy { it.originatingAddress!! }.mapNotNull { (address, pieces) ->
            val body = pieces.map { it.messageBody ?: return@mapNotNull null }.joinToString("").takeIf { it.isNotBlank() } ?: return@mapNotNull null
            Texts.Text(Texts.id("sms", "sms", address, pieces.first().timestampMillis, body), "sms", app, address, body, now)
        }
        if (texts.isNotEmpty()) Texts.submit(context, texts)
    }
}
