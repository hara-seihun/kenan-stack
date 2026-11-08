package com.example.kenan.android

import android.Manifest
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.content.pm.PackageManager
import android.content.pm.ServiceInfo
import android.media.AudioAttributes
import android.media.RingtoneManager
import android.net.Uri
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
    /** A tapped notification opens the app on its chat (MainActivity reads the conversationId extra). */
    const val OPEN_CONVERSATION = "com.example.kenan.open-conversation"
    /** Created before Do Not Disturb access was granted; Android then ignores the bypass request. */
    private const val URGENT_PLAIN = "agent-urgent"
    private const val URGENT_DND = "agent-urgent-dnd"
    private const val TAG = "agent-notification"
    private const val FRESH_MS = 10 * 60_000L
    private const val CONVERSATION = "kenan.conversationId"
    private const val NOTIFICATION_ID = "kenan.notificationId"
    private fun prefs(context: Context) = context.getSharedPreferences("kenan-alert-dismissals", Context.MODE_PRIVATE)

    /** Leave service, privacy and permission notices alone; only delivered agent alerts disappear. */
    fun clearDelivered(context: Context) {
        prefs(context).edit().putLong("openedAt", System.currentTimeMillis()).apply()
        val manager = manager(context)
        for (notice in manager.activeNotifications) if (notice.tag == TAG || notice.tag?.startsWith("$TAG-collapse:") == true)
            manager.cancel(notice.tag, notice.id)
    }

    /** The ID bound keeps a delayed read from cancelling a newer reply in the same chat. */
    fun clearChat(context: Context, conversationId: String, throughId: Long) {
        val prefs = prefs(context)
        val through = maxOf(prefs.getLong(conversationId, 0), throughId)
        prefs.edit().putLong(conversationId, through).apply()
        val manager = manager(context)
        for (notice in manager.activeNotifications) {
            val extras = notice.notification.extras
            if (extras.getString(CONVERSATION) == conversationId && extras.getLong(NOTIFICATION_ID, 0) <= through)
                manager.cancel(notice.tag, notice.id)
        }
    }

    fun deliveredStatus(context: Context): JSONObject = JSONObject()
        .put("visible", manager(context).activeNotifications.count { it.tag == TAG || it.tag?.startsWith("$TAG-collapse:") == true })
        .put("lastOpenedAt", prefs(context).getLong("openedAt", 0))

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
        val conversationId = notification.getString("conversationId")
        val dismissed = prefs(context)
        if (id <= dismissed.getLong(conversationId, 0) || notification.getLong("createdAt") <= dismissed.getLong("openedAt", 0)) return
        // Only automatic Kenaznia messages carry a collapse key. Explicit alerts keep their individual IDs.
        val collapseKey = if (notification.isNull("collapseKey")) null else notification.getString("collapseKey").takeIf { it.isNotBlank() }
        val tag = collapseKey?.let { "$TAG-collapse:$it" } ?: TAG
        val requestId = if (collapseKey != null) (tag.hashCode() and Int.MAX_VALUE).coerceAtLeast(1) else (id % Int.MAX_VALUE).toInt()
        val urgent = when (val level = notification.getString("level")) { "urgent" -> true; "normal" -> false; else -> throw IllegalArgumentException("Unknown notification level $level") }
        val quietHours = notification.optJSONObject("quietHours")
        if (!urgent && quietHours?.optBoolean("enabled") == true) {
            val local = java.util.Calendar.getInstance()
            val now = "%02d:%02d".format(java.util.Locale.ROOT, local.get(java.util.Calendar.HOUR_OF_DAY), local.get(java.util.Calendar.MINUTE))
            val start = quietHours.getString("start")
            val end = quietHours.getString("end")
            if (if (start <= end) now >= start && now < end else now >= start || now < end) return
        }
        val createdAt = notification.getLong("createdAt")
        val fresh = System.currentTimeMillis() - createdAt < FRESH_MS
        createChannels(context)
        val open = Intent(context, MainActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_CLEAR_TOP or Intent.FLAG_ACTIVITY_SINGLE_TOP)
            .setAction(OPEN_CONVERSATION).putExtra("conversationId", notification.getString("conversationId"))
        // PendingIntent compares data, not extras; even a hash collision must open the matching conversation.
        if (collapseKey != null) open.data = Uri.parse("kenan-alert:" + Uri.encode(tag))
        val body = notification.getString("body")
        val built = NotificationCompat.Builder(context, if (urgent) urgentChannel(context) else NORMAL)
            .setSmallIcon(R.drawable.ic_notification)
            .setContentTitle(notification.getString("title")).setContentText(body)
            .setStyle(if (image != null) NotificationCompat.BigPictureStyle().bigPicture(image).bigLargeIcon(null as android.graphics.Bitmap?).setSummaryText(body) else NotificationCompat.BigTextStyle().bigText(body))
            .setLargeIcon(android.graphics.BitmapFactory.decodeResource(context.resources, R.drawable.kenaznia_face))
            .addExtras(android.os.Bundle().apply { putString(CONVERSATION, conversationId); putLong(NOTIFICATION_ID, id) })
            .setWhen(createdAt).setShowWhen(true).setAutoCancel(true).setSilent(!fresh)
            .setCategory(if (urgent) NotificationCompat.CATEGORY_ALARM else NotificationCompat.CATEGORY_MESSAGE)
            .setPriority(if (urgent) NotificationCompat.PRIORITY_MAX else NotificationCompat.PRIORITY_HIGH)
            .setVisibility(if (urgent) NotificationCompat.VISIBILITY_PUBLIC else NotificationCompat.VISIBILITY_PRIVATE)
            .setContentIntent(PendingIntent.getActivity(context, requestId, open, PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE))
            .build()
        manager(context).notify(tag, requestId, built)
        BatteryDiag.count("notificationShown")
        NetworkDiag.note("notification_shown", "id=$id automatic=${collapseKey != null} enabled=${canPost(context)}")
    }
}

/**
 * Holds the phone's notification stream (GET /api/notifications) open while the app has a signed-in session.
 * Android requires a notification for this foreground service. It carries no connection status (the app's setup screen shows that)
 * and is posted only by startForeground, never updated, so it can't go stale and a swiped-away one stays away. Its channel is
 * minimised; turning that channel off hides it for good while the service keeps running. Signing out is the one state that needs the
 * person, so it gets its own ordinary notification, removed once the stream connects again.
 */
class NoticeService : Service() {
    companion object {
        private const val RUNNING_CHANNEL = "background-connection"
        private const val RUNNING_SETTINGS_REQUEST = 4814
        fun connectionNotificationStatus(context: Context): JSONObject {
            val manager = context.getSystemService(NotificationManager::class.java)
            val channel = manager.getNotificationChannel(RUNNING_CHANNEL)
            return JSONObject().put("channel", RUNNING_CHANNEL)
                .put("importance", channel?.importance ?: JSONObject.NULL)
                .put("badge", channel?.canShowBadge() ?: JSONObject.NULL)
                .put("blockable", if (Build.VERSION.SDK_INT >= 33) channel?.isBlockable ?: JSONObject.NULL else JSONObject.NULL)
                .put("settingsAvailable", connectionSettings(context).resolveActivity(context.packageManager) != null)
                .put("serviceRunning", running != null)
                .put("notificationVisible", manager.activeNotifications.any { it.id == 1 && it.notification.channelId == RUNNING_CHANNEL })
                .put("messageChannel", AgentAlerts.NORMAL)
                .put("messageImportance", manager.getNotificationChannel(AgentAlerts.NORMAL)?.importance ?: JSONObject.NULL)
        }
        private fun connectionSettings(context: Context) = Intent(android.provider.Settings.ACTION_CHANNEL_NOTIFICATION_SETTINGS)
            .putExtra(android.provider.Settings.EXTRA_APP_PACKAGE, context.packageName)
            .putExtra(android.provider.Settings.EXTRA_CHANNEL_ID, RUNNING_CHANNEL).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
        private const val RETIRED_STATUS_CHANNEL = "notice-connection"
        private const val SIGNED_OUT_TAG = "notice-signed-out"
        private const val PREFS = "kenan-next-device"
        private const val CURSOR = "notificationCursor"
        @Volatile var state = "Notifications are not connected"
            private set
        private val observers = linkedSetOf<(String) -> Unit>()
        fun observeState(observer: (String) -> Unit): () -> Unit {
            observers.add(observer); observer(state)
            return { observers.remove(observer); Unit }
        }
        fun signedIn(context: Context): Boolean = CookieManager.getInstance().getCookie(accountOrigin(context))?.split(';')?.any { it.trim().startsWith("kenan_session=") } == true
        /** The app calls this on every open. A running service only reconnects at once if it is between attempts, so its notification isn't posted again. */
        fun start(context: Context) {
            if (!signedIn(context)) return
            val current = running
            if (current == null) ContextCompat.startForegroundService(context, Intent(context, NoticeService::class.java))
            else Handler(Looper.getMainLooper()).post {
                if (running === current && !current.stopped) {
                    current.foregroundLocation()
                    if (current.call == null) { current.handler.removeCallbacks(current.reconnect); current.connect() }
                }
            }
        }
        /** A new session: the old stream ends and a new service starts with it. */
        fun restart(context: Context) {
            context.stopService(Intent(context, NoticeService::class.java)); running = null
            if (signedIn(context)) ContextCompat.startForegroundService(context, Intent(context, NoticeService::class.java))
        }
        private var running: NoticeService? = null
        /** Reopens the stream, so the server learns at once whether this phone can take phone-control commands. */
        fun reconnect() { Handler(Looper.getMainLooper()).post { running?.let { it.call?.cancel(); it.call = null; it.handler.removeCallbacks(it.reconnect); it.connect() } } }
    }
    private val handler = Handler(Looper.getMainLooper())
    // The native stream needs only a three-minute keepalive. Events still arrive immediately.
    private val client = OkHttpClient.Builder().readTimeout(240, TimeUnit.SECONDS).connectTimeout(20, TimeUnit.SECONDS).build()
    private var call: Call? = null
    private var stopped = false
    private var failures = 0
    /** The current stream has delivered nothing yet; its first event triggers a texts sync. */
    private var fresh = false
    private val reconnect = Runnable { connect() }
    private var network: NetworkMoves? = null
    private val timeZoneChanged = object : BroadcastReceiver() {
        override fun onReceive(context: Context, intent: Intent) {
            if (intent.action == Intent.ACTION_TIMEZONE_CHANGED) replace()
        }
    }
    private fun replace() { if (stopped) return; call?.cancel(); call = null; failures = 0; handler.removeCallbacks(reconnect); connect() }

    override fun onCreate() {
        super.onCreate()
        BatteryDiag.snapshot(this)
        running = this
        val zoneFilter = IntentFilter(Intent.ACTION_TIMEZONE_CHANGED)
        if (Build.VERSION.SDK_INT >= 33) registerReceiver(timeZoneChanged, zoneFilter, Context.RECEIVER_NOT_EXPORTED)
        else registerReceiver(timeZoneChanged, zoneFilter)
        val manager = getSystemService(NotificationManager::class.java)
        manager.createNotificationChannel(NotificationChannel(RUNNING_CHANNEL, "Background connection", NotificationManager.IMPORTANCE_MIN).apply {
            description = "Android shows this while $APP_LABEL stays connected for your agents' notifications. You can turn it off: notifications and urgent alerts keep arriving."
            setShowBadge(false)
            if (Build.VERSION.SDK_INT >= 33) setBlockable(true)
        })
        manager.deleteNotificationChannel(RETIRED_STATUS_CHANNEL)
        AgentAlerts.createChannels(this)
        // A stream from before a network move usually dies without closing: replace it rather than wait out the read timeout.
        network = NetworkMoves(this, first = { if (call == null && !stopped) replace() }, moved = ::replace)
        NetworkDiag.start(this)
        Texts.startTimer(this)
    }
    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        foregroundLocation()
        if (call == null) { handler.removeCallbacks(reconnect); connect() }
        return START_STICKY
    }
    private var foregroundTypes = -1
    private fun foregroundLocation() {
        val location = PhoneLocation.foregroundGranted(this) && PhoneLocation.backgroundGranted(this)
        var types = 0
        if (Build.VERSION.SDK_INT >= 34) types = types or ServiceInfo.FOREGROUND_SERVICE_TYPE_SPECIAL_USE
        if (Build.VERSION.SDK_INT >= 29 && location) types = types or ServiceInfo.FOREGROUND_SERVICE_TYPE_LOCATION
        if (foregroundTypes != types) {
            if (Build.VERSION.SDK_INT >= 29) startForeground(1, runningNotification(), types) else startForeground(1, runningNotification())
            foregroundTypes = types
        }
        if (location) PhoneLocation.serviceStarted(this) else PhoneLocation.serviceStopped(this)
    }
    /** Tapping it opens this channel's settings, where it can be turned off. */
    private fun runningNotification() = NotificationCompat.Builder(this, RUNNING_CHANNEL).setSmallIcon(R.drawable.ic_notification)
        .setContentTitle("$APP_LABEL is running").setContentText("Tap, then turn off Background connection")
        .setOngoing(true).setOnlyAlertOnce(true).setSilent(true).setShowWhen(false)
        .setCategory(NotificationCompat.CATEGORY_SERVICE).setPriority(NotificationCompat.PRIORITY_MIN)
        .setContentIntent(PendingIntent.getActivity(this, RUNNING_SETTINGS_REQUEST, connectionSettings(this),
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE)).build()
    private fun publish(value: String) {
        if (value == state) return
        state = value; observers.toList().forEach { it(value) }
        NetworkDiag.note("stream", value)
    }
    private fun signedOut(show: Boolean) {
        val manager = getSystemService(NotificationManager::class.java)
        if (!show) { manager.cancel(SIGNED_OUT_TAG, 1); return }
        if (stopped) return
        AgentAlerts.createChannels(this)
        manager.notify(SIGNED_OUT_TAG, 1, NotificationCompat.Builder(this, AgentAlerts.NORMAL).setSmallIcon(R.drawable.ic_notification)
            .setContentTitle("$APP_LABEL is signed out").setContentText("Open $APP_LABEL and sign in to get your agents' notifications again.")
            .setOnlyAlertOnce(true).setAutoCancel(true)
            .setContentIntent(PendingIntent.getActivity(this, 0, Intent(this, MainActivity::class.java), PendingIntent.FLAG_IMMUTABLE)).build())
    }
    private fun prefs() = getSharedPreferences(PREFS, Context.MODE_PRIVATE)

    private fun connect() {
        if (stopped) return
        BatteryDiag.count("notificationConnect")
        val origin = accountOrigin(this)
        val cookies = CookieManager.getInstance().getCookie(origin)
        if (cookies == null || !signedIn(this)) { publish("Waiting for you to sign in"); signedOut(true); retry(60_000); return }
        val cursor = prefs().getLong(CURSOR, -1)
        val query = listOfNotNull("zone=" + Uri.encode(java.util.TimeZone.getDefault().id), "settings=1", "dismissals=1", "heartbeatSeconds=180", if (cursor >= 0) "after=$cursor" else null, if (PhoneControl.serviceOn()) "phone=1" else null)
        val url = "$origin/api/notifications" + if (query.isEmpty()) "" else query.joinToString("&", "?")
        val current = client.newCall(Request.Builder().url(url).header("Cookie", cookies).header("Accept", "text/event-stream").build())
        call = current; fresh = true
        current.enqueue(object : Callback {
            override fun onFailure(call: Call, e: IOException) { ended(call, "Reconnecting (${e.javaClass.simpleName})") }
            override fun onResponse(call: Call, response: Response) {
                response.use {
                    if (response.code == 401) { ended(call, "Signed out; open $APP_LABEL to sign in", 300_000, needsSignIn = true); return }
                    if (!response.isSuccessful) { ended(call, "Reconnecting (HTTP ${response.code})"); return }
                    val source = response.body!!.source()
                    var event = ""; val data = StringBuilder()
                    try {
                        while (true) {
                            val line = source.readUtf8Line() ?: break
                            when {
                                line.isEmpty() -> { if (data.isNotEmpty()) received(call, event, data.toString(), if (event == "notification") image(data.toString(), cookies, origin) else null); event = ""; data.clear() }
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
    private fun image(data: String, cookies: String, origin: String): Result<android.graphics.Bitmap>? {
        val notification = runCatching { JSONObject(data).getJSONObject("notification") }.getOrNull() ?: return null
        if (notification.isNull("imageFileId")) return null
        return runCatching {
            client.newCall(Request.Builder().url("$origin/api/files/${notification.getString("imageFileId")}").header("Cookie", cookies).build()).execute().use { response ->
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
        if (fresh) { fresh = false; signedOut(false); Texts.sync(this); PhoneControl.refreshServer(this) }
        val handled = try {
            when (event) {
                "notification" -> {
                    val notification = JSONObject(data).getJSONObject("notification")
                    if (image != null && image.isFailure) notification.put("body", notification.getString("body") + "\n(The attached photo couldn't be loaded: ${image.exceptionOrNull()?.message}.)")
                    AgentAlerts.show(this, notification, image?.getOrNull())
                    check(prefs().edit().putLong(CURSOR, notification.getLong("id")).commit()) { "Notification cursor was not saved" }
                }
                "notifications_cleared" -> {
                    val cleared = JSONObject(data)
                    AgentAlerts.clearChat(this, cleared.getString("conversationId"), cleared.getLong("throughId"))
                }
                "heartbeat" -> BatteryDiag.count("notificationHeartbeat")
                "phone" -> PhoneControl.handle(this, JSONObject(data).getJSONObject("command"))
                "phone_settings" -> PhoneSettings.handle(this, JSONObject(data).getJSONObject("command"))
                else -> throw IllegalStateException("unknown event $event")
            }
            null
        } catch (e: Exception) { e }
        if (handled != null) { source.cancel(); ended(source, "Notification stream error: ${handled.message}", 60_000); return@post }
        publish(if (AgentAlerts.canPost(this)) "Connected" else "Connected, but Android notifications are off for $APP_LABEL")
    }
    private fun ended(source: Call, reason: String, delay: Long? = null, needsSignIn: Boolean = false) = handler.post {
        if (call !== source) return@post
        call = null
        publish(reason)
        if (needsSignIn) signedOut(true)
        failures++
        retry(delay ?: (minOf(300_000L, 1_000L shl minOf(failures, 9)) + kotlin.random.Random.nextLong(1000)))
    }
    private fun retry(delay: Long) { handler.removeCallbacks(reconnect); if (!stopped) handler.postDelayed(reconnect, delay) }

    override fun onBind(intent: Intent?): IBinder? = null
    override fun onDestroy() {
        stopped = true; if (running === this) running = null; handler.removeCallbacksAndMessages(null); call?.cancel(); call = null
        unregisterReceiver(timeZoneChanged)
        PhoneLocation.serviceStopped(this)
        network?.close(); network = null
        client.dispatcher.executorService.shutdown(); client.connectionPool.evictAll()
        state = "Notifications are not connected"; observers.toList().forEach { it(state) }
        super.onDestroy()
    }
}
