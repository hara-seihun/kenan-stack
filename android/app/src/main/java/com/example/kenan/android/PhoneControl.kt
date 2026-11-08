package com.example.kenan.android

import android.accessibilityservice.AccessibilityService
import android.accessibilityservice.GestureDescription
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.BroadcastReceiver
import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.graphics.Bitmap
import android.graphics.Path
import android.graphics.Rect
import android.os.Build
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.provider.Settings
import android.provider.Telephony
import android.util.Base64
import android.view.Display
import android.view.accessibility.AccessibilityEvent
import android.view.accessibility.AccessibilityNodeInfo
import android.webkit.CookieManager
import android.widget.Toast
import androidx.core.app.NotificationCompat
import okhttp3.Call
import okhttp3.Callback
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import okhttp3.Response
import org.json.JSONArray
import org.json.JSONObject
import java.io.ByteArrayOutputStream
import java.io.IOException
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit

/** A command's failure, posted back as {ok: false, error: {code, message}}. */
class PhoneRefusal(val code: String, message: String) : Exception(message)

/**
 * Phone control: the person's agents operate this phone through [PhoneControlService], only during a session that a
 * persistent "Kenan is using your phone · Stop" notification shows. Commands arrive on the notification stream
 * ([NoticeService], event "phone"); each answer is posted to /api/ext/phone/results.
 */
object PhoneControl {
    enum class Server { Unknown, Enabled, Disabled }
    const val IDLE_MS = 10 * 60_000L
    /** Screenshot pixels, the coordinates agents use: the long side is at most this (PHONE_SHOT_MAX_SIDE on the server). */
    private const val SHOT_MAX_SIDE = 1568
    private const val MAX_NODES = 400
    private const val PREFS = "kenan-phone"
    private const val SERVER = "server"
    private const val CHANNEL = "phone-control"
    private const val NOTICE_ID = 4401
    private val main = Handler(Looper.getMainLooper())
    private val work = Executors.newSingleThreadExecutor()
    private val client = OkHttpClient.Builder().connectTimeout(20, TimeUnit.SECONDS).readTimeout(30, TimeUnit.SECONDS).build()
    private var session: String? = null
    private var nodes: List<AccessibilityNodeInfo> = emptyList()
    private lateinit var app: Context
    private val idle = Runnable { end(app, "idle") }
    var serverChanged: ((Server) -> Unit)? = null

    private fun prefs(context: Context) = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
    fun server(context: Context): Server = prefs(context).getString(SERVER, null)?.let { Server.valueOf(it) } ?: Server.Unknown
    fun serviceOn(): Boolean = PhoneControlService.instance != null

    /** Android's Accessibility page with this app's service highlighted (the per-service page is reserved for system apps). */
    fun settingsIntent(context: Context): Intent {
        val component = ComponentName(context, PhoneControlService::class.java).flattenToString()
        return Intent(Settings.ACTION_ACCESSIBILITY_SETTINGS).putExtra(":settings:fragment_args_key", component)
            .putExtra(":settings:show_fragment_args", Bundle().apply { putString(":settings:fragment_args_key", component) })
    }
    const val EXPLANATION = "Kenan can use this phone for you: look at the screen, tap, scroll, type and open apps. Only while you can see it: " +
        "\"Kenan is using your phone · Stop\" stays in your notifications the whole time, Stop ends it at once, and it ends by itself after 10 minutes without activity. " +
        "It never sends texts, and never types a password except a saved one from your vault.\n\n" +
        "On the next screen, tap $APP_LABEL (under Downloaded apps or Installed apps), turn it on and tap Allow. If the switch is greyed out: open App info for $APP_LABEL, tap ⋮ at the top right, " +
        "choose \"Allow restricted settings\", then come back and try again."

    /** Learns whether phone control is enabled for the signed-in person (GET /api/ext/phone). Main thread. */
    fun refreshServer(context: Context) {
        val origin = accountOrigin(context)
        val cookies = CookieManager.getInstance().getCookie(origin) ?: return
        val appContext = context.applicationContext
        client.newCall(Request.Builder().url("$origin/api/ext/phone").header("Cookie", cookies).header("x-kenan-client", "native").build()).enqueue(object : Callback {
            override fun onFailure(call: Call, e: IOException) = Unit
            override fun onResponse(call: Call, response: Response) {
                val answer = when (response.use { it.code }) { 200 -> Server.Enabled; 403 -> Server.Disabled; else -> return }
                main.post {
                    if (server(appContext) == answer) return@post
                    check(prefs(appContext).edit().putString(SERVER, answer.name).commit()) { "Phone control state was not saved" }
                    serverChanged?.invoke(answer)
                }
            }
        })
    }

    private fun post(path: String, body: JSONObject) {
        val origin = accountOrigin(app)
        val cookies = CookieManager.getInstance().getCookie(origin) ?: return
        client.newCall(Request.Builder().url("$origin/api/ext/phone/$path").header("Cookie", cookies).header("x-kenan-client", "native")
            .post(body.toString().toRequestBody("application/json".toMediaType())).build()).enqueue(object : Callback {
            override fun onFailure(call: Call, e: IOException) = Unit
            override fun onResponse(call: Call, response: Response) { response.close() }
        })
    }
    private fun reply(id: String, outcome: Result<JSONObject>) {
        val body = JSONObject().put("id", id)
        outcome.fold({ body.put("ok", true).put("value", it) }, { e ->
            val code = (e as? PhoneRefusal)?.code ?: "phone_error"
            body.put("ok", false).put("error", JSONObject().put("code", code).put("message", e.message ?: e.javaClass.simpleName))
        })
        post("results", body)
    }

    /** One command from the stream. Main thread. */
    fun handle(context: Context, command: JSONObject, doneOverride: ((Result<JSONObject>) -> Unit)? = null) {
        app = context.applicationContext
        val id = command.getString("id")
        val done = doneOverride ?: { outcome: Result<JSONObject> -> reply(id, outcome) }
        try {
            val service = PhoneControlService.instance ?: throw PhoneRefusal("accessibility_off", "Kenan's accessibility service is off on the phone")
            val action = command.getString("action")
            val sessionId = command.getString("sessionId")
            when (action) {
                "start" -> { start(service, sessionId); done(Result.success(screen(service))) ; return }
                "end" -> { if (session == sessionId) end(app, null); done(Result.success(JSONObject().put("ended", true))); return }
            }
            if (session != sessionId) throw PhoneRefusal("phone_session_not_active", "The session on the phone has ended (Stop was tapped, or it was idle)")
            main.removeCallbacks(idle); main.postDelayed(idle, IDLE_MS)
            service.run(action, command, done)
        } catch (e: Exception) { done(Result.failure(e)) }
    }

    private fun start(service: PhoneControlService, sessionId: String) {
        session = sessionId; nodes = emptyList()
        val manager = service.getSystemService(NotificationManager::class.java)
        manager.createNotificationChannel(NotificationChannel(CHANNEL, "Kenan using this phone", NotificationManager.IMPORTANCE_DEFAULT).apply {
            description = "Shown the whole time Kenan is using this phone, with Stop"; setSound(null, null); setShowBadge(false)
        })
        val stop = PendingIntent.getBroadcast(service, 0, Intent(service, PhoneControlStop::class.java).setAction(PhoneControlStop.STOP_TAPPED), PendingIntent.FLAG_IMMUTABLE)
        val dismissed = PendingIntent.getBroadcast(service, 1, Intent(service, PhoneControlStop::class.java).setAction(PhoneControlStop.DISMISSED), PendingIntent.FLAG_IMMUTABLE)
        manager.notify(NOTICE_ID, NotificationCompat.Builder(service, CHANNEL).setSmallIcon(R.drawable.ic_notification)
            .setContentTitle("Kenan is using your phone").setContentText("Tap Stop to take it back. It ends by itself after 10 idle minutes.")
            .setOngoing(true).setOnlyAlertOnce(true).setSilent(true).setCategory(NotificationCompat.CATEGORY_STATUS)
            .setPriority(NotificationCompat.PRIORITY_HIGH).setVisibility(NotificationCompat.VISIBILITY_PUBLIC)
            .setContentIntent(PendingIntent.getActivity(service, 0, Intent(service, MainActivity::class.java), PendingIntent.FLAG_IMMUTABLE)).setDeleteIntent(dismissed).addAction(0, "Stop", stop).build())
        Toast.makeText(service, "Kenan started using your phone", Toast.LENGTH_LONG).show()
        main.removeCallbacks(idle); main.postDelayed(idle, IDLE_MS)
    }

    /** Ends the session here; reason (stop_tapped|dismissed|service_off|idle) tells the server when the phone ended it
     *  itself, null is an agent's end. She is told it is over unless she ended it herself. Main thread. */
    fun end(context: Context, reason: String?) {
        val ended = session ?: return
        session = null; nodes = emptyList(); main.removeCallbacks(idle)
        context.getSystemService(NotificationManager::class.java).cancel(NOTICE_ID)
        val service = PhoneControlService.instance
        when (reason) {
            null -> if (service != null) PhoneBubbles.done(service, "✅ Kenan is done with your phone", "You can use it again.")
                else Toast.makeText(context, "Kenan is done with your phone", Toast.LENGTH_LONG).show()
            "idle" -> if (service != null) PhoneBubbles.done(service, "Kenan stopped using your phone", "Nothing happened for ${IDLE_MS / 60_000} minutes. You can use it again.")
                else Toast.makeText(context, "Kenan stopped using your phone (idle)", Toast.LENGTH_LONG).show()
            else -> PhoneBubbles.clear()
        }
        if (reason != null) post("ended", JSONObject().put("sessionId", ended).put("reason", reason))
    }

    fun scale(service: PhoneControlService): Double {
        val size = service.screenSize()
        return minOf(1.0, SHOT_MAX_SIDE.toDouble() / maxOf(size.width(), size.height()))
    }
    private fun screen(service: PhoneControlService): JSONObject {
        val s = scale(service); val size = service.screenSize()
        return JSONObject().put("width", (size.width() * s).toInt()).put("height", (size.height() * s).toInt()).put("model", "${Build.MANUFACTURER} ${Build.MODEL}").put("android", Build.VERSION.RELEASE)
    }

    fun screenshot(service: PhoneControlService, done: (Result<JSONObject>) -> Unit) {
        if (Build.VERSION.SDK_INT < 30) throw PhoneRefusal("unsupported", "Screenshots need Android 11 or newer")
        PhoneBubbles.hiddenFor { restore -> capture(service) { restore(); done(it) } }
    }
    @androidx.annotation.RequiresApi(30)
    private fun capture(service: PhoneControlService, done: (Result<JSONObject>) -> Unit) {
        service.takeScreenshot(Display.DEFAULT_DISPLAY, work, object : AccessibilityService.TakeScreenshotCallback {
            override fun onSuccess(result: AccessibilityService.ScreenshotResult) {
                done(runCatching {
                    val hardware = result.hardwareBuffer
                    val wrapped = Bitmap.wrapHardwareBuffer(hardware, result.colorSpace) ?: throw PhoneRefusal("screenshot_failed", "The screenshot could not be read")
                    val full = wrapped.copy(Bitmap.Config.ARGB_8888, false); hardware.close()
                    val s = scale(service)
                    val shot = if (s < 1.0) Bitmap.createScaledBitmap(full, (full.width * s).toInt(), (full.height * s).toInt(), true) else full
                    val bytes = ByteArrayOutputStream().also { shot.compress(Bitmap.CompressFormat.JPEG, 80, it) }.toByteArray()
                    JSONObject().put("image", JSONObject().put("mime", "image/jpeg").put("base64", Base64.encodeToString(bytes, Base64.NO_WRAP)))
                        .put("width", shot.width).put("height", shot.height)
                })
            }
            override fun onFailure(errorCode: Int) { done(Result.failure(PhoneRefusal("screenshot_failed", "Android refused the screenshot (error $errorCode; at most one per second)"))) }
        })
    }

    /** The visible elements of every interactive window; their indexes are what tap and scroll accept as node. */
    fun ui(service: PhoneControlService): JSONObject {
        val s = scale(service)
        val found = mutableListOf<AccessibilityNodeInfo>()
        val out = JSONArray()
        fun visit(node: AccessibilityNodeInfo?) {
            if (node == null || found.size >= MAX_NODES) return
            if (node.isVisibleToUser) {
                val text = node.text?.toString().orEmpty(); val desc = node.contentDescription?.toString().orEmpty()
                if (text.isNotBlank() || desc.isNotBlank() || node.isClickable || node.isEditable || node.isScrollable || node.isCheckable) {
                    val r = Rect().also(node::getBoundsInScreen)
                    val item = JSONObject().put("node", found.size)
                    if (text.isNotBlank()) item.put("text", if (node.isPassword) "••••" else text.take(500))
                    if (desc.isNotBlank()) item.put("desc", desc.take(300))
                    node.viewIdResourceName?.let { item.put("id", it.substringAfter(":id/")) }
                    item.put("class", node.className?.toString()?.substringAfterLast('.') ?: "View")
                    item.put("bounds", JSONArray(listOf(r.left, r.top, r.right, r.bottom).map { (it * s).toInt() }))
                    for ((flag, on) in listOf("clickable" to node.isClickable, "longClickable" to node.isLongClickable, "editable" to node.isEditable,
                            "scrollable" to node.isScrollable, "focused" to node.isFocused, "password" to node.isPassword)) if (on) item.put(flag, true)
                    if (node.isCheckable) item.put("checked", node.isChecked)
                    found.add(node); out.put(item)
                }
            }
            for (i in 0 until node.childCount) visit(node.getChild(i))
        }
        val windows = service.windows.filterNot { PhoneBubbles.isBubble(service, it) }.sortedByDescending { it.layer }
        if (windows.isEmpty()) visit(service.rootInActiveWindow) else windows.forEach { visit(it.root) }
        nodes = found
        return JSONObject().put("package", service.rootInActiveWindow?.packageName?.toString()).put("nodes", out).put("truncated", found.size >= MAX_NODES)
            .put("bubble", PhoneBubbles.said ?: JSONObject.NULL)
    }
    fun node(index: Int): AccessibilityNodeInfo = nodes.getOrNull(index)?.takeIf { it.refresh() }
        ?: throw PhoneRefusal("stale_node", "Node $index is not on screen any more; call ui again")

    /** Texts are never sent: while the default SMS app is in front, Kenan may look but not touch. */
    fun refuseInSmsApp(service: PhoneControlService) {
        val sms = Telephony.Sms.getDefaultSmsPackage(service) ?: return
        if (service.rootInActiveWindow?.packageName?.toString() == sms) throw PhoneRefusal("sms_app_blocked", "Kenan never operates the messaging app (it could send a text); use back or home to leave it")
    }
    fun smsPackage(context: Context): String? = Telephony.Sms.getDefaultSmsPackage(context)
}

/** The accessibility service Carol turns on in Android settings. It only acts on commands of an active session. */
class PhoneControlService : AccessibilityService() {
    companion object { @Volatile var instance: PhoneControlService? = null; private set }
    override fun onServiceConnected() { instance = this; NoticeService.reconnect() }
    override fun onAccessibilityEvent(event: AccessibilityEvent?) = Unit
    override fun onInterrupt() = Unit
    override fun onUnbind(intent: Intent?): Boolean { gone(); return super.onUnbind(intent) }
    override fun onDestroy() { gone(); super.onDestroy() }
    private fun gone() { if (instance !== this) return; instance = null; PhoneControl.end(this, "service_off"); NoticeService.reconnect() }

    fun screenSize(): Rect = if (Build.VERSION.SDK_INT >= 30) getSystemService(android.view.WindowManager::class.java).maximumWindowMetrics.bounds
        else android.util.DisplayMetrics().also { @Suppress("DEPRECATION") getSystemService(android.view.WindowManager::class.java).defaultDisplay.getRealMetrics(it) }.let { Rect(0, 0, it.widthPixels, it.heightPixels) }

    private fun point(command: JSONObject, x: String, y: String): Pair<Float, Float> {
        val s = PhoneControl.scale(this)
        return Pair((command.getInt(x) / s).toFloat(), (command.getInt(y) / s).toFloat())
    }
    private fun gesture(path: Path, durationMs: Long, done: (Result<JSONObject>) -> Unit) {
        val dispatched = dispatchGesture(GestureDescription.Builder().addStroke(GestureDescription.StrokeDescription(path, 0, durationMs)).build(), object : GestureResultCallback() {
            override fun onCompleted(gestureDescription: GestureDescription?) { done(Result.success(JSONObject().put("done", true))) }
            override fun onCancelled(gestureDescription: GestureDescription?) { done(Result.failure(PhoneRefusal("gesture_cancelled", "Android cancelled the gesture"))) }
        }, null)
        if (!dispatched) done(Result.failure(PhoneRefusal("gesture_failed", "Android did not accept the gesture")))
    }
    private fun line(x1: Float, y1: Float, x2: Float, y2: Float) = Path().apply { moveTo(x1, y1); lineTo(x2, y2) }
    private fun acted(ok: Boolean, what: String): Result<JSONObject> = if (ok) Result.success(JSONObject().put("done", true)) else Result.failure(PhoneRefusal("action_failed", "$what was not performed"))

    fun run(action: String, command: JSONObject, done: (Result<JSONObject>) -> Unit) {
        when (action) {
            "screenshot" -> PhoneControl.screenshot(this, done)
            "ui" -> done(Result.success(PhoneControl.ui(this)))
            "tap" -> {
                PhoneControl.refuseInSmsApp(this)
                val long = command.getBoolean("long")
                val target = command.getJSONObject("target")
                when (val kind = target.getString("kind")) {
                    "node" -> {
                        val n = PhoneControl.node(target.getInt("node"))
                        if (!long && n.isClickable) done(acted(n.performAction(AccessibilityNodeInfo.ACTION_CLICK), "The tap"))
                        else if (long && n.isLongClickable) done(acted(n.performAction(AccessibilityNodeInfo.ACTION_LONG_CLICK), "The long press"))
                        else { val r = Rect().also(n::getBoundsInScreen); gesture(line(r.exactCenterX(), r.exactCenterY(), r.exactCenterX(), r.exactCenterY()), if (long) 800 else 60, done) }
                    }
                    "point" -> { val (x, y) = point(target, "x", "y"); gesture(line(x, y, x, y), if (long) 800 else 60, done) }
                    else -> throw PhoneRefusal("invalid_command", "Unknown tap target $kind")
                }
            }
            "swipe" -> {
                PhoneControl.refuseInSmsApp(this)
                val (x1, y1) = point(command, "x1", "y1"); val (x2, y2) = point(command, "x2", "y2")
                gesture(line(x1, y1, x2, y2), command.getLong("durationMs"), done)
            }
            "scroll" -> {
                PhoneControl.refuseInSmsApp(this)
                val direction = command.getString("direction")
                val forward = when (direction) { "down", "right" -> true; "up", "left" -> false; else -> throw PhoneRefusal("invalid_command", "Unknown direction $direction") }
                if (!command.isNull("node")) {
                    val n = PhoneControl.node(command.getInt("node"))
                    done(acted(n.performAction(if (forward) AccessibilityNodeInfo.ACTION_SCROLL_FORWARD else AccessibilityNodeInfo.ACTION_SCROLL_BACKWARD), "The scroll"))
                } else {
                    val r = screenSize(); val cx = r.exactCenterX(); val cy = r.exactCenterY()
                    val dx = r.width() * 0.3f; val dy = r.height() * 0.25f
                    when (direction) {
                        "down" -> gesture(line(cx, cy + dy, cx, cy - dy), 400, done)
                        "up" -> gesture(line(cx, cy - dy, cx, cy + dy), 400, done)
                        "right" -> gesture(line(cx + dx, cy, cx - dx, cy), 400, done)
                        else -> gesture(line(cx - dx, cy, cx + dx, cy), 400, done)
                    }
                }
            }
            "type" -> {
                PhoneControl.refuseInSmsApp(this)
                val field = findFocus(AccessibilityNodeInfo.FOCUS_INPUT) ?: throw PhoneRefusal("no_focused_field", "No text field has focus; tap one first")
                if (field.isPassword && !command.getBoolean("secret")) throw PhoneRefusal("password_needs_vault", "This is a password field: type a saved vault secret by reference, never plain text")
                val args = Bundle().apply { putCharSequence(AccessibilityNodeInfo.ACTION_ARGUMENT_SET_TEXT_CHARSEQUENCE, command.getString("text")) }
                done(acted(field.performAction(AccessibilityNodeInfo.ACTION_SET_TEXT, args), "Typing"))
            }
            "key" -> when (val key = command.getString("key")) {
                "back" -> done(acted(performGlobalAction(GLOBAL_ACTION_BACK), "Back"))
                "home" -> done(acted(performGlobalAction(GLOBAL_ACTION_HOME), "Home"))
                "recents" -> done(acted(performGlobalAction(GLOBAL_ACTION_RECENTS), "Recents"))
                "notifications" -> done(acted(performGlobalAction(GLOBAL_ACTION_NOTIFICATIONS), "Notifications"))
                "enter" -> {
                    PhoneControl.refuseInSmsApp(this)
                    if (Build.VERSION.SDK_INT < 30) throw PhoneRefusal("unsupported", "Enter needs Android 11 or newer")
                    val field = findFocus(AccessibilityNodeInfo.FOCUS_INPUT) ?: throw PhoneRefusal("no_focused_field", "No text field has focus")
                    done(acted(field.performAction(AccessibilityNodeInfo.AccessibilityAction.ACTION_IME_ENTER.id), "Enter"))
                }
                else -> throw PhoneRefusal("invalid_command", "Unknown key $key")
            }
            "open" -> {
                val pkg = command.getString("package")
                if (pkg == PhoneControl.smsPackage(this)) throw PhoneRefusal("sms_app_blocked", "Kenan never opens the messaging app")
                val launch = packageManager.getLaunchIntentForPackage(pkg) ?: throw PhoneRefusal("app_not_found", "No launchable app $pkg on this phone")
                startActivity(launch.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_RESET_TASK_IF_NEEDED))
                done(Result.success(JSONObject().put("opened", pkg)))
            }
            "say" -> {
                val point = if (command.isNull("point")) null else point(command.getJSONObject("point"), "x", "y")
                val place = when (val p = command.getString("place")) {
                    "top" -> PhoneBubbles.Place.Top
                    "bottom" -> PhoneBubbles.Place.Bottom
                    "away" -> {
                        val y = point?.second ?: throw PhoneRefusal("invalid_command", "place away needs a point")
                        if (y < screenSize().exactCenterY()) PhoneBubbles.Place.Bottom else PhoneBubbles.Place.Top
                    }
                    else -> throw PhoneRefusal("invalid_command", "Unknown place $p")
                }
                PhoneBubbles.say(this, command.getString("text"), place, point)
                done(Result.success(JSONObject().put("shown", true).put("place", place.name.lowercase())))
            }
            else -> throw PhoneRefusal("invalid_command", "Unknown action $action")
        }
    }
}

/** Stop on the session notification, or swiping it away. */
class PhoneControlStop : BroadcastReceiver() {
    companion object { const val STOP_TAPPED = "stop_tapped"; const val DISMISSED = "dismissed" }
    override fun onReceive(context: Context, intent: Intent) {
        when (val reason = intent.action) { STOP_TAPPED, DISMISSED -> PhoneControl.end(context, reason) }
    }
}
