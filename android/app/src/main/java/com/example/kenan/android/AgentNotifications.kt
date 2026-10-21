package com.example.kenan.android

import android.Manifest
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.content.pm.ServiceInfo
import android.media.AudioAttributes
import android.media.RingtoneManager
import android.net.ConnectivityManager
import android.net.Network
import android.os.Build
import android.os.Handler
import android.os.IBinder
import android.os.Looper
import android.webkit.CookieManager
import androidx.core.app.NotificationCompat
import androidx.core.content.ContextCompat
import okhttp3.Call
import okhttp3.Callback
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.Response
import org.json.JSONObject
import java.io.IOException
import java.util.concurrent.TimeUnit

/** Notifications agents send through the notify tool: an ordinary channel and an urgent one that rings through silent mode and Do Not Disturb. */
object AgentAlerts {
    const val NORMAL = "agent-notifications"
    /** Created before Do Not Disturb access was granted; Android then ignores the bypass request. */
    private const val URGENT_PLAIN = "agent-urgent"
    private const val URGENT_DND = "agent-urgent-dnd"
    private const val TAG = "agent-notification"
    private const val FRESH_MS = 10 * 60_000L

    private fun manager(context: Context) = context.getSystemService(NotificationManager::class.java)

    fun canPost(context: Context) = manager(context).areNotificationsEnabled() &&
        (Build.VERSION.SDK_INT < 33 || ContextCompat.checkSelfPermission(context, Manifest.permission.POST_NOTIFICATIONS) == PackageManager.PERMISSION_GRANTED)

    fun dndAccess(context: Context) = manager(context).isNotificationPolicyAccessGranted

    /** The urgent channel bypasses Do Not Disturb once Kenan holds notification-policy access. */
    fun urgentChannel(context: Context): String {
        val manager = manager(context)
        if (manager.getNotificationChannel(URGENT_DND) != null) return URGENT_DND
        val dnd = manager.isNotificationPolicyAccessGranted
        val id = if (dnd) URGENT_DND else URGENT_PLAIN
        manager.createNotificationChannel(NotificationChannel(id, "Urgent", NotificationManager.IMPORTANCE_HIGH).apply {
            description = "Time-sensitive alerts from your agents. They ring on the alarm volume, even on silent and in Do Not Disturb."
            setSound(RingtoneManager.getDefaultUri(RingtoneManager.TYPE_ALARM),
                AudioAttributes.Builder().setUsage(AudioAttributes.USAGE_ALARM).setContentType(AudioAttributes.CONTENT_TYPE_SONIFICATION).build())
            enableVibration(true); vibrationPattern = longArrayOf(0, 600, 300, 600, 300, 600)
            lockscreenVisibility = android.app.Notification.VISIBILITY_PUBLIC
            setBypassDnd(true)
        })
        if (dnd) manager.deleteNotificationChannel(URGENT_PLAIN)
        return id
    }

    fun createChannels(context: Context) {
        manager(context).createNotificationChannel(NotificationChannel(NORMAL, "Agent notifications", NotificationManager.IMPORTANCE_HIGH).apply {
            description = "Updates your agents send you"
        })
        urgentChannel(context)
    }

    /** Shows one notification from the stream. Stale ones (replayed after a long disconnect) arrive silently. */
    fun show(context: Context, notification: JSONObject, image: android.graphics.Bitmap?) {
        val id = notification.getLong("id")
        val urgent = when (val level = notification.getString("level")) { "urgent" -> true; "normal" -> false; else -> throw IllegalArgumentException("Unknown notification level $level") }
        val createdAt = notification.getLong("createdAt")
        val fresh = System.currentTimeMillis() - createdAt < FRESH_MS
        createChannels(context)
        val open = Intent(context, MainActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_CLEAR_TOP or Intent.FLAG_ACTIVITY_SINGLE_TOP)
        val body = notification.getString("body")
        val built = NotificationCompat.Builder(context, if (urgent) urgentChannel(context) else NORMAL)
            .setSmallIcon(R.drawable.ic_notification)
            .setContentTitle(notification.getString("title")).setContentText(body)
            .setStyle(if (image != null) NotificationCompat.BigPictureStyle().bigPicture(image).bigLargeIcon(null as android.graphics.Bitmap?).setSummaryText(body) else NotificationCompat.BigTextStyle().bigText(body))
            .setLargeIcon(android.graphics.BitmapFactory.decodeResource(context.resources, R.drawable.kenaznia_face))
            .setWhen(createdAt).setShowWhen(true).setAutoCancel(true).setSilent(!fresh)
            .setCategory(if (urgent) NotificationCompat.CATEGORY_ALARM else NotificationCompat.CATEGORY_MESSAGE)
            .setPriority(if (urgent) NotificationCompat.PRIORITY_MAX else NotificationCompat.PRIORITY_HIGH)
            .setVisibility(if (urgent) NotificationCompat.VISIBILITY_PUBLIC else NotificationCompat.VISIBILITY_PRIVATE)
            .setContentIntent(PendingIntent.getActivity(context, 0, open, PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE))
            .build()
        manager(context).notify(TAG, (id % Int.MAX_VALUE).toInt(), built)
    }
}

/** Holds the phone's notification stream (GET /api/notifications) open while the app has a signed-in session. */
class NoticeService : Service() {
    companion object {
        private const val STATUS_CHANNEL = "notice-connection"
        private const val PREFS = "kenan-next-device"
        private const val CURSOR = "notificationCursor"
        @Volatile var state = "Notifications are not connected"
            private set
        private val observers = linkedSetOf<(String) -> Unit>()
        fun observeState(observer: (String) -> Unit): () -> Unit {
            observers.add(observer); observer(state)
            return { observers.remove(observer); Unit }
        }
        fun signedIn(): Boolean = CookieManager.getInstance().getCookie(BETA_ORIGIN)?.split(';')?.any { it.trim().startsWith("kenan_session=") } == true
        fun start(context: Context) { if (signedIn()) ContextCompat.startForegroundService(context, Intent(context, NoticeService::class.java)) }
    }
    private val handler = Handler(Looper.getMainLooper())
    // The server sends a heartbeat every 15 s, so 45 s of silence means the connection is gone.
    private val client = OkHttpClient.Builder().readTimeout(45, TimeUnit.SECONDS).connectTimeout(20, TimeUnit.SECONDS).build()
    private var call: Call? = null
    private var stopped = false
    private var failures = 0
    /** The current stream has delivered nothing yet; its first event triggers a texts sync. */
    private var fresh = false
    private val reconnect = Runnable { connect() }
    private val network = object : ConnectivityManager.NetworkCallback() {
        override fun onAvailable(network: Network) { handler.post { if (call == null && !stopped) { handler.removeCallbacks(reconnect); connect() } } }
    }

    override fun onCreate() {
        super.onCreate()
        getSystemService(NotificationManager::class.java).createNotificationChannel(
            NotificationChannel(STATUS_CHANNEL, "Notification connection", NotificationManager.IMPORTANCE_MIN).apply { setShowBadge(false) })
        AgentAlerts.createChannels(this)
        getSystemService(ConnectivityManager::class.java).registerDefaultNetworkCallback(network)
    }
    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        val status = statusNotification("Connecting")
        if (Build.VERSION.SDK_INT >= 34) startForeground(1, status, ServiceInfo.FOREGROUND_SERVICE_TYPE_SPECIAL_USE) else startForeground(1, status)
        if (call == null) { handler.removeCallbacks(reconnect); connect() }
        return START_STICKY
    }
    private fun statusNotification(text: String) = NotificationCompat.Builder(this, STATUS_CHANNEL).setSmallIcon(R.drawable.ic_notification)
        .setContentTitle("$APP_LABEL notifications").setContentText(text).setOngoing(true).setOnlyAlertOnce(true).setSilent(true)
        .setContentIntent(PendingIntent.getActivity(this, 0, Intent(this, MainActivity::class.java), PendingIntent.FLAG_IMMUTABLE)).build()
    private fun publish(value: String) {
        if (value == state) return
        state = value; observers.toList().forEach { it(value) }
        if (!stopped) getSystemService(NotificationManager::class.java).notify(1, statusNotification(value))
    }
    private fun prefs() = getSharedPreferences(PREFS, Context.MODE_PRIVATE)

    private fun connect() {
        if (stopped) return
        val cookies = CookieManager.getInstance().getCookie(BETA_ORIGIN)
        if (cookies == null || !signedIn()) { publish("Waiting for you to sign in"); retry(60_000); return }
        val cursor = prefs().getLong(CURSOR, -1)
        val url = "$BETA_ORIGIN/api/notifications" + if (cursor >= 0) "?after=$cursor" else ""
        val current = client.newCall(Request.Builder().url(url).header("Cookie", cookies).header("Accept", "text/event-stream").build())
        call = current; fresh = true
        current.enqueue(object : Callback {
            override fun onFailure(call: Call, e: IOException) { ended(call, "Reconnecting (${e.javaClass.simpleName})") }
            override fun onResponse(call: Call, response: Response) {
                response.use {
                    if (response.code == 401) { ended(call, "Signed out; open $APP_LABEL to sign in", 300_000); return }
                    if (!response.isSuccessful) { ended(call, "Reconnecting (HTTP ${response.code})"); return }
                    val source = response.body!!.source()
                    var event = ""; val data = StringBuilder()
                    try {
                        while (true) {
                            val line = source.readUtf8Line() ?: break
                            when {
                                line.isEmpty() -> { if (data.isNotEmpty()) received(call, event, data.toString(), if (event == "notification") image(data.toString(), cookies) else null); event = ""; data.clear() }
                                line.startsWith("event:") -> event = line.removePrefix("event:").trim()
                                line.startsWith("data:") -> { if (data.isNotEmpty()) data.append('\n'); data.append(line.removePrefix("data:").removePrefix(" ")) }
                            }
                        }
                        ended(call, "Reconnecting (stream closed)")
                    } catch (e: IOException) { ended(call, "Reconnecting (${e.javaClass.simpleName})") }
                }
            }
        })
    }
    /** Runs on the stream's thread. An image that can't be fetched leaves the notification text-only and says so. */
    private fun image(data: String, cookies: String): Result<android.graphics.Bitmap>? {
        val notification = runCatching { JSONObject(data).getJSONObject("notification") }.getOrNull() ?: return null
        if (notification.isNull("imageFileId")) return null
        return runCatching {
            client.newCall(Request.Builder().url("$BETA_ORIGIN/api/files/${notification.getString("imageFileId")}").header("Cookie", cookies).build()).execute().use { response ->
                check(response.isSuccessful) { "HTTP ${response.code}" }
                val bytes = response.body!!.bytes()
                val bounds = android.graphics.BitmapFactory.Options().apply { inJustDecodeBounds = true }
                android.graphics.BitmapFactory.decodeByteArray(bytes, 0, bytes.size, bounds)
                var sample = 1; while (maxOf(bounds.outWidth, bounds.outHeight) / (sample * 2) >= 1080) sample *= 2
                android.graphics.BitmapFactory.decodeByteArray(bytes, 0, bytes.size, android.graphics.BitmapFactory.Options().apply { inSampleSize = sample })
                    ?: throw IllegalStateException("undecodable image")
            }
        }
    }
    private fun received(source: Call, event: String, data: String, image: Result<android.graphics.Bitmap>?) = handler.post {
        if (call !== source || stopped) return@post
        failures = 0
        if (fresh) { fresh = false; Texts.sync(this) }
        val handled = try {
            when (event) {
                "notification" -> {
                    val notification = JSONObject(data).getJSONObject("notification")
                    if (image != null && image.isFailure) notification.put("body", notification.getString("body") + "\n(The attached photo couldn't be loaded: ${image.exceptionOrNull()?.message}.)")
                    AgentAlerts.show(this, notification, image?.getOrNull())
                    check(prefs().edit().putLong(CURSOR, notification.getLong("id")).commit()) { "Notification cursor was not saved" }
                }
                "heartbeat" -> Unit
                else -> throw IllegalStateException("unknown event $event")
            }
            null
        } catch (e: Exception) { e }
        if (handled != null) { source.cancel(); ended(source, "Notification stream error: ${handled.message}", 60_000); return@post }
        publish(if (AgentAlerts.canPost(this)) "Connected" else "Connected, but Android notifications are off for $APP_LABEL")
    }
    private fun ended(source: Call, reason: String, delay: Long? = null) = handler.post {
        if (call !== source) return@post
        call = null
        publish(reason)
        failures++
        retry(delay ?: minOf(60_000L, 1_000L shl minOf(failures, 6)))
    }
    private fun retry(delay: Long) { handler.removeCallbacks(reconnect); if (!stopped) handler.postDelayed(reconnect, delay) }

    override fun onBind(intent: Intent?): IBinder? = null
    override fun onDestroy() {
        stopped = true; handler.removeCallbacksAndMessages(null); call?.cancel(); call = null
        getSystemService(ConnectivityManager::class.java).unregisterNetworkCallback(network)
        client.dispatcher.executorService.shutdown(); client.connectionPool.evictAll()
        state = "Notifications are not connected"; observers.toList().forEach { it(state) }
        super.onDestroy()
    }
}
