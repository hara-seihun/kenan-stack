package com.example.kenan.android

import android.Manifest
import android.app.AppOpsManager
import android.os.Process
import android.telephony.TelephonyManager
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.net.Uri
import android.provider.Settings
import androidx.core.app.NotificationCompat
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.database.ContentObserver
import android.os.Build
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
import java.util.concurrent.Executors

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
    private const val LAST_UPLOAD = "lastUpload"
    private const val RETRY_MS = 2 * 60_000L
    private const val LEARN_MS = 3600_000L
    private const val PROMPT_CHANNEL = "texts-setup"
    private const val PROMPT_TAG = "texts-access"
    /** Intent action that sends the person to the screen where SMS permission is granted. */
    const val FIX_SMS = "com.example.kenan.texts-fix-sms"
    private const val SYNC_MS = 24 * 3600_000L
    private val main = Handler(Looper.getMainLooper())
    private val client = OkHttpClient.Builder().connectTimeout(20, TimeUnit.SECONDS).readTimeout(30, TimeUnit.SECONDS).build()
    private var inFlight = false
    private var again = false
    private var timerStarted = false
    private val reader = Executors.newSingleThreadExecutor()
    private var syncing = false
    private var syncAgain = false
    private var observer: ContentObserver? = null
    private const val LAST_SYNC = "lastSync"
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

    fun queueLength(context: Context): Int = JSONArray(prefs(context).getString(PENDING, "[]")).length()

    /** What the server's heartbeat reports about this feed: both permissions, the queue and how the last upload went. */
    @Suppress("DEPRECATION")
    fun status(context: Context): JSONObject = JSONObject().put("server", server(context).name).put("smsPermission", smsGranted(context))
        .put("notificationAccess", notificationAccess(context)).put("queue", queueLength(context))
        .put("lastSync", prefs(context).getString(LAST_SYNC, null)?.let { JSONObject(it) } ?: JSONObject.NULL)
        .put("smsObserver", observer != null)
        .put("smsReadAppOp", context.getSystemService(AppOpsManager::class.java).checkOpNoThrow(AppOpsManager.OPSTR_READ_SMS, Process.myUid(), context.packageName))
        .put("smsReceiveAppOp", context.getSystemService(AppOpsManager::class.java).checkOpNoThrow(AppOpsManager.OPSTR_RECEIVE_SMS, Process.myUid(), context.packageName))
        .put("simNumber", runCatching { context.getSystemService(TelephonyManager::class.java).line1Number }.fold(
            { it?.takeIf { number -> number.isNotBlank() } ?: JSONObject.NULL }, { JSONObject().put("error", it.javaClass.simpleName) }))
        .put("defaultAssistant", Settings.Secure.getString(context.contentResolver, "assistant") ?: JSONObject.NULL)
        .put("lastUpload", prefs(context).getString(LAST_UPLOAD, null)?.let { JSONObject(it) } ?: JSONObject.NULL)

    private var timer: Runnable? = null
    /** Incoming texts and reconnects send immediately. Only failed sends need a two-minute retry. */
    fun startTimer(context: Context) {
        if (timerStarted) return
        timerStarted = true
        val app = context.applicationContext
        timer = Runnable {
            BatteryDiag.count("textsMaintenance")
            runCatching { prompt(app); sync(app) }
            schedule(app)
        }
        main.post(timer!!)
    }
    private fun schedule(context: Context) {
        val next = timer ?: return
        main.removeCallbacks(next)
        main.postDelayed(next, if (queueLength(context) > 0) RETRY_MS else LEARN_MS)
    }

    /** A persistent notification while the server keeps texts and either permission is missing; one tap opens the screen, then one toggle. */
    fun prompt(context: Context) {
        val manager = context.getSystemService(NotificationManager::class.java)
        val missing = if (server(context) != Server.Enabled) null else when {
            !smsGranted(context) -> "SMS permission"
            !notificationAccess(context) -> "Notification access"
            else -> null
        }
        if (missing == null) { manager.cancel(PROMPT_TAG, 1); return }
        manager.createNotificationChannel(NotificationChannel(PROMPT_CHANNEL, "Texts setup", NotificationManager.IMPORTANCE_DEFAULT).apply { description = "Shown while your agents can't read your texts because a permission is off." })
        val tap = if (!smsGranted(context)) PendingIntent.getActivity(context, 2, Intent(context, MainActivity::class.java).setAction(FIX_SMS).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_SINGLE_TOP), PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT)
        else PendingIntent.getActivity(context, 3, notificationAccessIntent(context).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK), PendingIntent.FLAG_IMMUTABLE)
        manager.notify(PROMPT_TAG, 1, NotificationCompat.Builder(context, PROMPT_CHANNEL).setSmallIcon(R.drawable.ic_notification)
            .setContentTitle("Your agents can't read your texts").setContentText("$missing is off. Tap to turn it on.")
            .setOngoing(true).setOnlyAlertOnce(true).setCategory(NotificationCompat.CATEGORY_ERROR).setContentIntent(tap).build())
    }

    fun notificationAccessIntent(context: Context): Intent {
        val component = android.content.ComponentName(context, PhoneNotifications::class.java)
        return if (Build.VERSION.SDK_INT >= 30) Intent(Settings.ACTION_NOTIFICATION_LISTENER_DETAIL_SETTINGS).putExtra(Settings.EXTRA_NOTIFICATION_LISTENER_COMPONENT_NAME, component.flattenToString())
        else Intent(Settings.ACTION_NOTIFICATION_LISTENER_SETTINGS)
    }

    fun appDetailsIntent(context: Context) = Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS, Uri.parse("package:${context.packageName}"))

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

    /** Observe the inbox as well as broadcasts: Android may withhold a verification SMS broadcast. */
    private fun observe(context: Context) {
        if (observer != null || !smsGranted(context)) return
        val changed = Runnable { sync(context) }
        val next = object : ContentObserver(main) {
            override fun onChange(selfChange: Boolean) {
                main.removeCallbacks(changed)
                main.postDelayed(changed, 350)
            }
        }
        context.contentResolver.registerContentObserver(Telephony.Sms.CONTENT_URI, true, next)
        observer = next
    }

    /** Backfill the last day without blocking the app or its notification stream. Main thread. */
    fun sync(context: Context) {
        val appContext = context.applicationContext
        if (!smsGranted(context)) { flush(appContext); return }
        observe(appContext)
        if (syncing) { syncAgain = true; return }
        syncing = true; syncAgain = false
        val app = Telephony.Sms.getDefaultSmsPackage(context) ?: "sms"
        reader.execute {
            val result = runCatching {
                val texts = mutableListOf<Text>()
                appContext.contentResolver.query(Telephony.Sms.Inbox.CONTENT_URI, arrayOf("address", "body", "date", "date_sent"),
                    "date > ?", arrayOf((System.currentTimeMillis() - SYNC_MS).toString()), "date ASC")?.use { c ->
                    while (c.moveToNext()) {
                        val address = c.getString(0) ?: continue
                        val body = c.getString(1)?.takeIf { it.isNotBlank() } ?: continue
                        texts.add(Text(id("sms", "sms", address, c.getLong(3), body), "sms", app, address, body, c.getLong(2)))
                    }
                } ?: throw IllegalStateException("SMS provider returned no cursor")
                texts
            }
            main.post {
                syncing = false
                val report = JSONObject().put("at", System.currentTimeMillis())
                result.fold({ texts ->
                    report.put("read", texts.size).put("result", "ok")
                    submit(appContext, texts)
                }, { error ->
                    report.put("result", error.javaClass.simpleName).put("message", error.message)
                    flush(appContext)
                })
                prefs(appContext).edit().putString(LAST_SYNC, report.toString()).apply()
                if (syncAgain) sync(appContext)
            }
        }
    }

    /** Sends everything queued; an empty send still learns whether the server keeps texts for this person. Main thread. */
    fun flush(context: Context) {
        if (inFlight) { again = true; return }
        val origin = accountOrigin(context)
        val cookies = CookieManager.getInstance().getCookie(origin) ?: return
        val batch = JSONArray(prefs(context).getString(PENDING, "[]"))
        inFlight = true; again = false
        val request = Request.Builder().url("$origin/api/ext/texts").header("Cookie", cookies).header("x-kenan-client", "native")
            .post(JSONObject().put("texts", batch).toString().toRequestBody("application/json".toMediaType())).build()
        client.newCall(request).enqueue(object : Callback {
            override fun onFailure(call: Call, e: IOException) { main.post { done(context, batch, null, e.javaClass.simpleName) } }
            override fun onResponse(call: Call, response: Response) { val code = response.use { it.code }; main.post { done(context, batch, code, "http $code") } }
        })
    }

    private fun done(context: Context, batch: JSONArray, code: Int?, result: String) {
        inFlight = false
        prefs(context).edit().putString(LAST_UPLOAD, JSONObject().put("at", System.currentTimeMillis()).put("result", result).put("sent", batch.length()).toString()).apply()
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
        schedule(context)
        // Errors keep the queue; incoming texts and reconnects also retry immediately.
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

