package com.example.kenan.android

import android.hardware.Sensor
import android.hardware.SensorEvent
import android.hardware.SensorEventListener
import android.hardware.SensorManager
import android.view.ViewGroup
import android.Manifest
import android.app.AlertDialog
import android.content.MutableContextWrapper
import android.content.Intent
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.provider.Settings
import android.webkit.CookieManager
import android.webkit.PermissionRequest
import android.webkit.ValueCallback
import android.webkit.WebChromeClient
import android.webkit.WebResourceRequest
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.FrameLayout
import androidx.core.view.WindowCompat
import androidx.core.view.ViewCompat
import android.widget.Button
import android.widget.LinearLayout
import android.widget.TextView
import androidx.activity.ComponentActivity
import androidx.activity.OnBackPressedCallback
import androidx.activity.result.contract.ActivityResultContracts
import androidx.core.content.ContextCompat
import androidx.webkit.JavaScriptReplyProxy
import androidx.webkit.WebViewCompat
import androidx.webkit.WebViewFeature
import org.json.JSONObject
import java.util.UUID
import java.util.concurrent.Executors

private const val NETWORK_MOVED = "dispatchEvent(new Event('online'))"

open class MainActivity : ComponentActivity(), SensorEventListener {
    private val embeddedOrigin get() = accountOrigin(this)
    private lateinit var automaticUpdates: AutomaticUpdates
    private lateinit var sensors: SensorManager
    private val shake = ShakeDetector()
    private var setupVisible = true
    private lateinit var store: DeviceStore
    private var web: WebView? = null
    private var startup: GatewayStartup? = null
    private var rendererRecoveries = 0
    private var webBridge: WarmPages.Bridge? = null
    private var warmPageKey: WarmPages.Key? = null
    private var setupHeader: TextView? = null
    private var stopStateObservation: (() -> Unit)? = null
    private var media: PermissionRequest? = null
    private var mediaDialog: AlertDialog? = null
    private lateinit var attachments: AttachmentChooser
    private lateinit var shares: ShareInbox
    private var lastWebSession: String? = null
    @Volatile private var destroyed = false
    /** The page's event stream (web/events.ts) replaces itself on `online`; a VPN that moves between Wi-Fi and cellular never goes offline, so the shell says so. */
    private var networkMoves: NetworkMoves? = null
    @Volatile private var webGeneration = 0L
    private val cookieWork = Executors.newSingleThreadExecutor()
    private lateinit var downloads: GatewayDownload
    private var downloadSource: GatewayDownload.Source? = null
    private val saveDocument = registerForActivityResult(ActivityResultContracts.CreateDocument("*/*")) { destination ->
        val source = downloadSource; downloadSource = null
        if (destination != null && source != null) {
            val gateway = Gateway.parse(source.origin)
            if (gateway !is Outcome.Ok || !trustedUrl(web?.url, gateway.value) || sessionCookies(source.origin) != source.cookies) showMessage("Download session changed; no data was transferred")
            else work.execute {
                val result = downloads.save(source, destination)
                runOnUiThread { if (!destroyed) showMessage(when (result) {
                    is Outcome.Ok -> "Saved ${result.value.getLong("savedBytes")} bytes"
                    is Outcome.Err -> "${result.message}. The selected document may contain a partial transfer."
                }) }
            }
        }
    }
    private val work = Executors.newSingleThreadExecutor()
    private val locationPermission = registerForActivityResult(ActivityResultContracts.RequestMultiplePermissions()) { PhoneLocation.start(this, prompt = true); NoticeService.start(this); notificationSetup() }
    private val backgroundLocationPermission = registerForActivityResult(ActivityResultContracts.RequestPermission()) { PhoneLocation.start(this, prompt = true); NoticeService.start(this); notificationSetup() }
    private val noticePermission = registerForActivityResult(ActivityResultContracts.RequestPermission()) { NoticeService.start(this); notificationSetup() }
    private val permissions = registerForActivityResult(ActivityResultContracts.RequestMultiplePermissions()) { showSetup() }
    private val smsPermission = registerForActivityResult(ActivityResultContracts.RequestMultiplePermissions()) { Texts.sync(this); notificationSetup() }
    private val mediaPermissions = registerForActivityResult(ActivityResultContracts.RequestMultiplePermissions()) {
        val request = media; media = null
        if (request != null && mediaTrusted(request) && requiredMediaPermissions(request).all { permission -> granted(permission) }) request.grant(request.resources)
        else request?.deny()
    }
    override fun onCreate(savedInstanceState: Bundle?) { super.onCreate(savedInstanceState); networkMoves = NetworkMoves(this, first = {}, moved = { web?.evaluateJavascript(NETWORK_MOVED, null) }); WindowCompat.setDecorFitsSystemWindows(window, false); window.decorView.setBackgroundColor(android.graphics.Color.BLACK); window.statusBarColor = android.graphics.Color.BLACK; window.navigationBarColor = android.graphics.Color.BLACK
        WindowCompat.getInsetsController(window, window.decorView).apply { isAppearanceLightStatusBars = false; isAppearanceLightNavigationBars = false }
        if (Build.VERSION.SDK_INT >= 29) { window.isStatusBarContrastEnforced = false; window.isNavigationBarContrastEnforced = false }
        WarmPages.register(this); onBackPressedDispatcher.addCallback(this, back)
        attachments = AttachmentChooser(this, ::showMessage)
        shares = ShareInbox(this); if (savedInstanceState == null) shares.receive(intent)
        automaticUpdates = AutomaticUpdates(this, { accountOrigin(this) }) { renderSetupState(NoticeService.state) }
        when (val scheduled = BetaUpdateCheck.schedule(this)) { is Outcome.Ok -> Unit; is Outcome.Err -> showMessage(scheduled.message) }
        store = DeviceStore(this); downloads = GatewayDownload(this); sensors = getSystemService(SENSOR_SERVICE) as SensorManager; openGateway((Gateway.parse(embeddedOrigin) as Outcome.Ok).value) }
    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent); setIntent(intent)
        if (shares.receive(intent)) web?.let { view -> if (setupVisible) showGateway(view); view.evaluateJavascript("dispatchEvent(new Event('kenan-share'))", null) }
        routeNotice(intent, (Gateway.parse(embeddedOrigin) as Outcome.Ok).value)
        if (intent.action == AssistActivity.ASSIST_ACTION) web?.let { view -> if (setupVisible) showGateway(view) }
    }
    /** Routes an opened notification inside the already rendered document. */
    private fun routeNotice(intent: Intent, gateway: Gateway) {
        val target = notificationDestination(intent, gateway) ?: return
        web?.let { view ->
            if (setupVisible) showGateway(view)
            val presence = NativeThreadPresence.current(this)
            val uri = Uri.parse(target)
            val sameThread = presence != null && presence.accountId == uri.getQueryParameter("accountId") &&
                presence.domainId == uri.getQueryParameter("noticeDomainId") && presence.conversationId == uri.getQueryParameter("conversationId")
            if (trustedUrl(view.url, gateway) && sameThread) { markVisibleThreadRead(); return }
            if (!trustedUrl(view.url, gateway)) { view.loadUrl(target); return }
            val detail = JSONObject().put("accountId", uri.getQueryParameter("accountId"))
                .put("domainId", uri.getQueryParameter("noticeDomainId")).put("conversationId", uri.getQueryParameter("conversationId"))
            val generation = webGeneration
            view.evaluateJavascript("!window.dispatchEvent(new CustomEvent('kenan-open-conversation',{cancelable:true,detail:$detail}))") { accepted ->
                if (!destroyed && web === view && generation == webGeneration && this.intent === intent && accepted != "true") view.loadUrl(target)
            }
        }
    }
    private fun notificationDestination(intent: Intent?, gateway: Gateway): String? {
        if (intent?.action == AgentAlerts.OPEN_CONVERSATION) {
            val conversation = intent.getStringExtra("conversationId")?.takeIf { it.isNotBlank() } ?: return null
            return Uri.parse(gateway.origin + "/").buildUpon().appendQueryParameter("conversationId", conversation).build().toString()
        }
        if (intent?.action != "open-notice") return null
        val account = intent.getStringExtra("accountId") ?: return null
        val domain = intent.getStringExtra("noticeDomainId") ?: return null
        val conversation = intent.getStringExtra("conversationId")?.takeIf { it.isNotBlank() } ?: return null
        if (account != store.prefs.getString("ownerId", null) || domain != store.prefs.getString("domainId", null)) return null
        return Uri.parse(gateway.origin + "/").buildUpon().appendQueryParameter("accountId", account)
            .appendQueryParameter("noticeDomainId", domain).appendQueryParameter("conversationId", conversation).build().toString()
    }
    override fun onResume() { super.onResume(); AgentAlerts.clearDelivered(this); PhoneLocation.start(this, prompt = true); fixTexts(); Texts.prompt(this); ChatHeads.foreground(this, this, true); ChatHeads.retireSystemBubbles(this); web?.onResume(); web?.evaluateJavascript("if(window.KenanNext){window.KenanNext.foreground=true;dispatchEvent(new Event('kenan-app-visibility'));}", null); refreshSession((Gateway.parse(embeddedOrigin) as Outcome.Ok).value); automaticUpdates.resume(); shake.reset(); sensors.getDefaultSensor(Sensor.TYPE_ACCELEROMETER)?.let { sensors.registerListener(this, it, SensorManager.SENSOR_DELAY_UI) }; NativeThreadPresence.lifecycle(this, true); NativeThreadPresence.showChat(this, !setupVisible); stopStateObservation?.invoke(); stopStateObservation = NoticeService.observeState(::renderSetupState); Texts.serverChanged = { if (it == Texts.Server.Enabled) notificationSetup() }; PhoneControl.serverChanged = { if (it == PhoneControl.Server.Enabled) notificationSetup() }; NoticeService.start(this); notificationSetup() }
    override fun onPostResume() { super.onPostResume(); window.decorView.post { if (!destroyed) markVisibleThreadRead() } }
    private fun markVisibleThreadRead() {
        val presence = NativeThreadPresence.current(this) ?: return
        if (!lifecycle.currentState.isAtLeast(androidx.lifecycle.Lifecycle.State.RESUMED) || setupVisible ||
            !getSystemService(android.os.PowerManager::class.java).isInteractive || getSystemService(android.app.KeyguardManager::class.java).isKeyguardLocked) return
        ChatHeads.clearPreview(presence.accountId, presence.domainId, presence.conversationId ?: return)
    }
    override fun onPause() { ChatHeads.foreground(this, this, false); web?.evaluateJavascript("if(window.KenanNext){window.KenanNext.foreground=false;dispatchEvent(new Event('kenan-app-visibility'));}", null); web?.onPause(); automaticUpdates.pause(); sensors.unregisterListener(this); shake.reset(); stopStateObservation?.invoke(); stopStateObservation = null; Texts.serverChanged = null; PhoneControl.serverChanged = null; NativeThreadPresence.lifecycle(this, false); super.onPause() }
    override fun onDestroy() { destroyed = true; networkMoves?.close(); networkMoves = null; webGeneration++; cookieWork.shutdown(); automaticUpdates.close(); stopStateObservation?.invoke(); stopStateObservation = null; setupHeader = null; closeWeb(retainPage = true); downloads.close(); shares.close(); work.execute { store.close() }; work.shutdown(); NativeThreadPresence.remove(this); super.onDestroy() }
    override fun onAccuracyChanged(sensor: Sensor?, accuracy: Int) = Unit
    override fun onSensorChanged(event: SensorEvent) {
        if (event.sensor.type == Sensor.TYPE_ACCELEROMETER && !setupVisible && shake.sample(event.timestamp, event.values[0], event.values[1], event.values[2])) {
            web?.performHapticFeedback(CONFIRM_HAPTIC)
            showSetup()
        }
    }
    private var backQuery = 0L
    /** Back closes the settings screen, then the page's topmost overlay (the page answers through window.kenanBack), and only then leaves. */
    private val back = object : OnBackPressedCallback(true) {
        override fun handleOnBackPressed() {
            val view = web ?: return leave()
            if (setupVisible) return showGateway(view)
            val query = ++backQuery
            val unanswered = Runnable { if (query == backQuery) { backQuery++; leave() } }
            view.postDelayed(unanswered, 400)
            view.evaluateJavascript("typeof window.kenanBack==='function'&&window.kenanBack()") { closed ->
                if (query != backQuery || destroyed) return@evaluateJavascript
                backQuery++; view.removeCallbacks(unanswered)
                if (closed != "true") leave()
            }
        }
    }
    /** Back with nothing open inside the page: what the system does for this window. */
    protected open fun leave() { back.isEnabled = false; onBackPressedDispatcher.onBackPressed(); back.isEnabled = true }
    private fun showInsetContent(view: android.view.View) {
        val frame = FrameLayout(this).apply { setBackgroundColor(if (this@MainActivity is BubbleActivity) android.graphics.Color.TRANSPARENT else android.graphics.Color.BLACK) }
        frame.addView(view, FrameLayout.LayoutParams(-1, -1))
        fitChatInsets(frame)
        setContentView(frame)
        ViewCompat.requestApplyInsets(frame)
    }
    protected open fun decorateChat(view: android.view.View): android.view.View = view
    private fun showGateway(view: WebView) {
        NativeThreadPresence.showChat(this, true)
        val surface = startup ?: return
        (surface.parent as? ViewGroup)?.removeView(surface)
        setupVisible = false; setupHeader = null
        showInsetContent(decorateChat(surface)); markVisibleThreadRead()
    }
    private fun showMessage(message: String) { AlertDialog.Builder(this).setMessage(message).setPositiveButton("OK", null).show() }
    /** The retained page this window may adopt: its pinned conversation for a bubble, the main document otherwise. */
    private fun warmKey(gateway: Gateway): WarmPages.Key? {
        val session = sessionCookies(gateway.origin)?.let(::sessionIdentity) ?: return null
        if (this !is BubbleActivity) return WarmPages.Key(gateway.origin, session, WarmPages.Target.Main)
        val target = notificationDestination(intent, gateway) ?: return null
        val uri = Uri.parse(target)
        return WarmPages.Key(gateway.origin, session, WarmPages.Target.Thread(uri.getQueryParameter("accountId")!!,
            uri.getQueryParameter("noticeDomainId")!!, uri.getQueryParameter("conversationId")!!))
    }
    private fun closeWeb(retainPage: Boolean = false) {
        startup?.close(); startup = null
        val view = web
        val presence = NativeThreadPresence.current(this)
        val gateway = (Gateway.parse(embeddedOrigin) as Outcome.Ok).value
        val key = warmPageKey
        val target = key?.target
        val retain = retainPage && view != null && key != null && key == warmKey(gateway) && trustedUrl(view.url, gateway) && when (target) {
            is WarmPages.Target.Main -> true
            is WarmPages.Target.Thread -> presence != null && presence.accountId == target.account && presence.domainId == target.domain && presence.conversationId == target.conversation
            null -> false
        }
        NativeThreadPresence.record(this, null); NativeThreadPresence.showChat(this, false)
        downloads.cancel(); downloadSource = null; mediaDialog?.dismiss(); mediaDialog = null; media?.deny(); media = null; attachments.cancel()
        if (view != null) {
            // Detached pages must not keep an Activity, bridge, picker or permission callback alive.
            webBridge?.listener = null
            if (!retain) WebViewCompat.removeWebMessageListener(view, "KenanNext")
            view.webViewClient = WebViewClient(); view.webChromeClient = null; view.setDownloadListener(null)
            if (retain) WarmPages.put(key!!, WarmPages.Page(view, presence, webBridge!!))
            else { (view.parent as? ViewGroup)?.removeView(view); view.destroy() }
        }
        web = null; webBridge = null; warmPageKey = null
    }
    private fun granted(permission: String) = ContextCompat.checkSelfPermission(this, permission) == PackageManager.PERMISSION_GRANTED
    private fun sessionCookies(origin: String): String? = CookieManager.getInstance().getCookie(origin)?.takeIf { cookies -> cookies.split(';').any { it.trim().startsWith("kenan_session=") } }
    private fun trustedUrl(url: String?, gateway: Gateway): Boolean {
        if (url == null) return false
        val uri = Uri.parse(url)
        val origin = Gateway.parse("${uri.scheme}://${uri.authority}")
        return origin is Outcome.Ok && origin.value.origin == gateway.origin && uri.path in setOf("", "/", "/app") && sessionCookies(gateway.origin) != null
    }
    private fun personalDocument(url: String?, gateway: Gateway): Boolean {
        if (url == null) return false
        val uri = Uri.parse(url); val origin = Gateway.parse("${uri.scheme}://${uri.authority}")
        return origin is Outcome.Ok && origin.value.origin == gateway.origin && uri.path in setOf("", "/", "/app") && uri.getQueryParameter("domainId") == null
    }
    private fun personalUrl(url: String?, gateway: Gateway): Boolean = personalDocument(url, gateway) && sessionCookies(gateway.origin) != null
    private fun refreshSession(gateway: Gateway): Outcome<JSONObject> = boundary {
        cookieWork.execute {
            val saved = boundary { CookieManager.getInstance().flush(); JSONObject() }
            if (saved is Outcome.Err) runOnUiThread { if (!destroyed) showMessage(saved.message) }
        }
        val current = sessionCookies(gateway.origin)?.let(::sessionIdentity)
        val changed = lastWebSession != current
        if (changed) {
            NativeThreadPresence.clear()
            webGeneration++
            downloads.cancel(); downloadSource = null
            media?.deny(); media = null; mediaDialog?.dismiss(); mediaDialog = null
            attachments.cancel()
            WarmPages.clear()
            ChatHeads.forget(this)
            store.clearSessionBinding()
            NoticeService.restart(this)
        }
        lastWebSession = current
        JSONObject().put("sessionRefreshed", changed)
    }

    private fun button(layout: LinearLayout, title: String, action: () -> Unit) { layout.addView(Button(this).apply { text = title; setOnClickListener { action() } }) }
    private fun renderSetupState(state: String) {
        setupHeader?.text = "${APP_LABEL}\nVersion ${BuildConfig.VERSION_NAME} (${BuildConfig.VERSION_CODE})\n$state\nUpdate: ${store.prefs.getString("updateStatus", "not requested")}\n${store.prefs.getString("updateCheckStatus", "Check has not completed")}"
    }
    private fun showSetup() {
        setupVisible = true; NativeThreadPresence.showChat(this, false)
        startup?.let { (it.parent as? ViewGroup)?.removeView(it) }
        val layout = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL; setPadding(24, 24, 24, 24) }
        setupHeader = TextView(this).also(layout::addView)
        renderSetupState(NoticeService.state)
        layout.addView(TextView(this).apply { text = embeddedOrigin })
        val status = TextView(this); layout.addView(status)
        button(layout, "Return to chat") {
            val current = web
            if (current != null) showGateway(current)
            else openGateway((Gateway.parse(embeddedOrigin) as Outcome.Ok).value)
        }
        button(layout, "Check / retry app update") {
            status.text = "Checking signed ${APP_LABEL} feed"
            automaticUpdates.request { outcome -> status.text = when (outcome) { is Outcome.Ok -> outcome.value.toString(); is Outcome.Err -> outcome.message } }
        }
        button(layout, "Allow verified package updates") { startActivity(Intent(Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES, Uri.parse("package:$packageName"))) }
        button(layout, "Notification setup") { val current = web; if (current != null) showGateway(current); notificationSetup(force = true) }
        if (PhoneControl.server(this) == PhoneControl.Server.Enabled) button(layout, if (PhoneControl.serviceOn()) "Kenan can use this phone (change)" else "Allow Kenan to use this phone") {
            AlertDialog.Builder(this).setTitle("Allow Kenan to use this phone").setMessage(PhoneControl.EXPLANATION)
                .setPositiveButton("Open settings") { _, _ -> startActivity(PhoneControl.settingsIntent(this)) }.setNegativeButton("Not now", null).show()
        }
        button(layout, "Disconnect and disable") { disconnect(); showSetup() }
        showInsetContent(android.widget.ScrollView(this).apply { addView(layout) })
    }
    /** The texts setup notification's tap: the SMS permission dialog, or the app's permission screen once Android stops showing it. */
    private fun fixTexts() {
        if (intent?.action != Texts.FIX_SMS) return
        intent.action = null
        val sms = arrayOf(Manifest.permission.RECEIVE_SMS, Manifest.permission.READ_SMS)
        if (sms.all { granted(it) }) return
        if (!store.prefs.getBoolean("smsPermissionAsked", false) || sms.any { shouldShowRequestPermissionRationale(it) }) { store.prefs.edit().putBoolean("smsPermissionAsked", true).apply(); smsPermission.launch(sms) }
        else startActivity(Texts.appDetailsIntent(this))
    }
    private fun openNotificationSettings() = notificationSetup(force = true)
    private var notificationDialog: AlertDialog? = null
    /** Restore texts access first, then offer notification and location setup, one step at a time. */
    private fun notificationSetup(force: Boolean = false) {
        if (destroyed || setupVisible || notificationDialog?.isShowing == true || !NoticeService.signedIn(this)) return
        val prefs = store.prefs
        val now = System.currentTimeMillis()
        // A fresh install or revoked texts access must not wait behind optional alert tuning.
        val textsSetup = Texts.server(this) == Texts.Server.Enabled && (!Texts.smsGranted(this) || !Texts.notificationAccess(this)) &&
            (force || now >= prefs.getLong("textsSetupSnoozedUntil", 0))
        if (!force && now < prefs.getLong("notificationSetupSnoozedUntil", 0) && !textsSetup) return
        AgentAlerts.createChannels(this)
        val manager = getSystemService(android.app.NotificationManager::class.java)
        val urgent = manager.getNotificationChannel(AgentAlerts.urgentChannel(this))
        fun open(intent: Intent) { try { startActivity(intent) } catch (e: android.content.ActivityNotFoundException) { startActivity(Intent(Settings.ACTION_APP_NOTIFICATION_SETTINGS).putExtra(Settings.EXTRA_APP_PACKAGE, packageName)) } }
        val appSettings = Intent(Settings.ACTION_APP_NOTIFICATION_SETTINGS).putExtra(Settings.EXTRA_APP_PACKAGE, packageName)
        val step: Triple<String, String, () -> Unit>? = when {
            textsSetup && !Texts.smsGranted(this) -> Triple("Let your agents read texts", "Then sign-in and confirmation codes reach your agents without you copying them over. Allow SMS on the next screen.") {
                val sms = arrayOf(Manifest.permission.RECEIVE_SMS, Manifest.permission.READ_SMS)
                if (!prefs.getBoolean("smsPermissionAsked", false) || sms.any { shouldShowRequestPermissionRationale(it) }) { prefs.edit().putBoolean("smsPermissionAsked", true).apply(); smsPermission.launch(sms) }
                else open(Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS, Uri.parse("package:$packageName")))
            }
            textsSetup && !Texts.notificationAccess(this) -> Triple("Codes sent as chat messages", "Some codes arrive as chat (RCS) messages, which only show up as notifications. Turn on $APP_LABEL on the next screen. If the switch is greyed out, open App info, tap ⋮, choose \"Allow restricted settings\", then come back.") {
                open(Texts.notificationAccessIntent(this))
            }
            !AgentAlerts.canPost(this) -> Triple("Turn on notifications", "Your agents can send you notifications here, like when food is arriving or something needs you now.") {
                if (Build.VERSION.SDK_INT >= 33 && !granted(Manifest.permission.POST_NOTIFICATIONS) && !prefs.getBoolean("notificationPermissionAsked", false)) {
                    prefs.edit().putBoolean("notificationPermissionAsked", true).apply(); noticePermission.launch(Manifest.permission.POST_NOTIFICATIONS)
                } else open(appSettings)
            }
            !PhoneLocation.foregroundGranted(this) && !prefs.getBoolean("locationAsked", false) -> Triple("Share your location", "Allow location so your agents can know where you are. Use precise location to identify home Wi-Fi; approximate location still gives a rough place.") {
                prefs.edit().putBoolean("locationAsked", true).apply(); locationPermission.launch(arrayOf(Manifest.permission.ACCESS_COARSE_LOCATION, Manifest.permission.ACCESS_FINE_LOCATION))
            }
            Build.VERSION.SDK_INT >= 29 && PhoneLocation.foregroundGranted(this) && !PhoneLocation.backgroundGranted(this) && !prefs.getBoolean("backgroundLocationAsked", false) -> Triple("Share location in the background", "Allow location all the time so your agents can see where you are without opening the app.") {
                prefs.edit().putBoolean("backgroundLocationAsked", true).apply()
                if (Build.VERSION.SDK_INT == 29) backgroundLocationPermission.launch(Manifest.permission.ACCESS_BACKGROUND_LOCATION)
                else open(Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS, Uri.parse("package:$packageName")))
            }
            !AgentAlerts.dndAccess(this) -> Triple("Let urgent alerts through", "Urgent alerts from your agents ring on the alarm volume, so they sound even when your phone is on silent. To also get through Do Not Disturb, turn on $APP_LABEL on the next screen (Do Not Disturb access).") {
                open(Intent(Settings.ACTION_NOTIFICATION_POLICY_ACCESS_SETTINGS))
            }
            urgent == null || !urgent.canBypassDnd() || urgent.importance < android.app.NotificationManager.IMPORTANCE_HIGH -> Triple("Check urgent alerts", "On the next screen, make sure Urgent is allowed to pop on screen and that \"Override Do Not Disturb\" is on. That is what lets urgent alerts ring through Do Not Disturb.") {
                open(Intent(Settings.ACTION_CHANNEL_NOTIFICATION_SETTINGS).putExtra(Settings.EXTRA_APP_PACKAGE, packageName).putExtra(Settings.EXTRA_CHANNEL_ID, urgent?.id ?: AgentAlerts.urgentChannel(this)))
            }
            !getSystemService(android.os.PowerManager::class.java).isIgnoringBatteryOptimizations(packageName) -> Triple("Deliver notifications on time", "Android can hold back notifications while your phone sleeps. Allow $APP_LABEL to stay connected in the background.") {
                open(Intent(Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS, Uri.parse("package:$packageName")))
            }
            PhoneControl.server(this) == PhoneControl.Server.Enabled && !PhoneControl.serviceOn() && !prefs.getBoolean("phoneControlAsked", false) -> Triple("Allow Kenan to use this phone", PhoneControl.EXPLANATION) {
                prefs.edit().putBoolean("phoneControlAsked", true).apply(); open(PhoneControl.settingsIntent(this))
            }
            else -> null
        }
        if (step == null) { if (force) showMessage("Notifications are set up: ordinary ones arrive normally, and urgent ones ring through silent mode and Do Not Disturb.${if (Texts.server(this) == Texts.Server.Enabled) " Your agents can read the texts you receive." else ""}\n\n${NoticeService.state}"); return }
        notificationDialog = AlertDialog.Builder(this).setTitle(step.first).setMessage(step.second)
            .setPositiveButton("Continue") { _, _ -> step.third() }
            .setNegativeButton("Not now") { _, _ -> prefs.edit().putLong(if (textsSetup) "textsSetupSnoozedUntil" else "notificationSetupSnoozedUntil", System.currentTimeMillis() + 24 * 3600_000L).apply() }
            .show()
    }
    private fun disconnect() { ChatHeads.forget(this); WarmPages.clear(); NativeThreadPresence.clear(); store.unbind() }
    private fun setOverlay(enabled: Boolean): Outcome<JSONObject> {
        if (enabled && !Settings.canDrawOverlays(this)) return Outcome.Err("permission_missing", "Allow overlay display in Android settings")
        if (enabled && store.prefs.getString("sessionEpoch", null) == null) return Outcome.Err("disconnected", "Connect an authenticated owner first")
        check(store.prefs.edit().putBoolean("overlayEnabled", enabled).commit())
        return Outcome.Ok(JSONObject().put("enabled", enabled))
    }
    private fun requiredMediaPermissions(request: PermissionRequest) = request.resources.map { resource -> when (resource) {
        PermissionRequest.RESOURCE_AUDIO_CAPTURE -> Manifest.permission.RECORD_AUDIO
        PermissionRequest.RESOURCE_VIDEO_CAPTURE -> Manifest.permission.CAMERA
        else -> "unsupported"
    } }
    private fun mediaTrusted(request: PermissionRequest): Boolean {
        val configured = accountOrigin(this)
        val gateway = Gateway.parse(configured)
        return gateway is Outcome.Ok && request.origin.toString().trimEnd('/') == configured && trustedUrl(web?.url, gateway.value) && !destroyed
    }
    private fun reply(proxy: JavaScriptReplyProxy, id: String?, outcome: Outcome<JSONObject>) { proxy.postMessage(JSONObject().put("id", id ?: JSONObject.NULL).put("result", outcome.json()).toString()) }
    private var accountMovePending = false
    private fun moveAccount(view: WebView, source: Gateway, args: JSONObject, id: String?, proxy: JavaScriptReplyProxy) {
        val parsed = Gateway.parse(args.getString("origin"))
        require(parsed is Outcome.Ok && parsed.value.origin.startsWith("https://")) { "Account destination must be an HTTPS origin" }
        val target = parsed.value
        val token = args.getString("token")
        val account = args.getString("accountId")
        require(token.isNotBlank() && account.isNotBlank() && target.origin != source.origin) { "Invalid account move" }
        require(store.prefs.getString("ownerId", null)?.let { it == account } != false) { "Account does not match this device owner" }
        require(!accountMovePending) { "Account move already in progress" }
        val sourceSession = sessionCookies(source.origin)
        val generation = webGeneration
        accountMovePending = true
        cookieWork.execute {
            // Never pass remote response text or exception messages to the web page: they may contain the token.
            val cookie = try {
                val connection = java.net.URL(target.origin + "/api/account-arrive").openConnection() as java.net.HttpURLConnection
                try {
                    connection.instanceFollowRedirects = false
                    connection.connectTimeout = 15000; connection.readTimeout = 15000
                    connection.requestMethod = "POST"; connection.doOutput = true
                    connection.setRequestProperty("Content-Type", "application/json")
                    connection.setRequestProperty("x-kenan-client", "native")
                    connection.outputStream.use { it.write(JSONObject().put("token", token).toString().toByteArray(Charsets.UTF_8)) }
                    check(connection.responseCode == 200)
                    val body = connection.inputStream.bufferedReader().use { it.readText() }
                    val value = JSONObject(body)
                    check(value.optBoolean("ok") && value.getJSONObject("value").getString("personId") == account)
                    connection.headerFields.entries.filter { it.key?.equals("Set-Cookie", true) == true }
                        .flatMap { it.value }.firstOrNull {
                            val parts = it.split(';').map(String::trim)
                            parts.firstOrNull()?.startsWith("kenan_session=") == true &&
                                parts.any { part -> part.equals("secure", true) } && parts.any { part -> part.equals("httponly", true) }
                        } ?: error("Missing session cookie")
                } finally { connection.disconnect() }
            } catch (_: Exception) { null }
            runOnUiThread {
                fun current(): Boolean = !destroyed && web === view && generation == webGeneration &&
                    accountOrigin(this) == source.origin && personalUrl(view.url, source) &&
                    sessionCookies(source.origin) == sourceSession && store.prefs.getString("ownerId", null)?.let { it == account } != false
                if (cookie == null || !current()) {
                    accountMovePending = false
                    if (!destroyed) reply(proxy, id, Outcome.Err("platform_failure", "Account move failed or the current session changed"))
                } else CookieManager.getInstance().setCookie(target.origin, cookie) { accepted ->
                    if (!accepted || !current()) {
                        accountMovePending = false
                        if (!destroyed) reply(proxy, id, Outcome.Err("platform_failure", "Account move failed or the current session changed"))
                    } else {
                        CookieManager.getInstance().flush()
                        val saved = store.prefs.edit().putString("gateway", target.origin).remove("sessionEpoch").remove("conversationId").commit()
                        accountMovePending = false
                        if (!saved) reply(proxy, id, Outcome.Err("platform_failure", "Could not save account destination"))
                        else {
                            reply(proxy, id, Outcome.Ok(JSONObject().put("moved", true)))
                            NativeThreadPresence.clear(); WarmPages.clear(); ChatHeads.forget(this)
                            NoticeService.restart(this)
                            openGateway(target)
                        }
                    }
                }
            }
        }
    }
    private fun installBridge(view: WebView, gateway: Gateway) {
        val binding = webBridge!!
        binding.listener = androidx.webkit.WebViewCompat.WebMessageListener { _, message, origin, mainFrame, proxy ->
            if (destroyed || web !== view || !mainFrame || origin.toString().trimEnd('/') != gateway.origin || !personalDocument(view.url, gateway)) return@WebMessageListener
            var id: String? = null
            val response = boundary {
                val input = JSONObject(message.data ?: ""); id = input.getString("id")
                val args = input.getJSONObject("args"); val name = input.getString("name")
                require(name in DeviceManifest.BRIDGE_COMMANDS) { "Unknown native bridge operation" }
                require(name == "refreshSession" || personalUrl(view.url, gateway)) { "Sign in before using native device authority" }
                if (name == "moveAccount") { moveAccount(view, gateway, args, id, proxy); return@boundary JSONObject().put("deferred", true) }
                if (name == "apkUpdate") { val requestId = id; automaticUpdates.request { outcome -> if (!destroyed) reply(proxy, requestId, outcome) }; return@boundary JSONObject().put("deferred", true) }
                if (name == "takeShare") { val requestId = id; shares.take(gateway.origin) { outcome -> if (!destroyed) reply(proxy, requestId, outcome) }; return@boundary JSONObject().put("deferred", true) }
                val outcome = when (name) {
                    "refreshSession" -> refreshSession(gateway)
                    "threadPresence" -> {
                        val account = args.getString("accountId"); val domain = args.getString("domainId")
                        require(account.isNotBlank() && domain.isNotBlank())
                        val conversation = if (args.isNull("conversationId")) null else args.getString("conversationId").also { require(it.isNotBlank()) }
                        val presence = ThreadPresence(account, domain, conversation, args.getBoolean("visible"))
                        NativeThreadPresence.record(this, presence)
                        if (conversation != null) ChatHeads.offer(this, account, domain, conversation, "Kenaznia")
                        markVisibleThreadRead()
                        Outcome.Ok(JSONObject().put("recorded", true))
                    }
                    "status" -> Outcome.Ok(JSONObject().put("versionCode", BuildConfig.VERSION_CODE).put("deviceId", store.deviceId).put("connection", NoticeService.state))
                    "disconnect" -> { disconnect(); Outcome.Ok(JSONObject().put("disconnected", true)) }
                    "overlay" -> setOverlay(args.getBoolean("enabled"))
                    "openSettings" -> { view.post { if (!destroyed) { if (args.optString("section") == "notifications") openNotificationSettings() else showSetup() } }; Outcome.Ok(JSONObject().put("opened", true)) }
                    "openFinder" -> { view.post { if (!destroyed) startActivity(Intent(this, FinderActivity::class.java)) }; Outcome.Ok(JSONObject().put("opened", true)) }
                    "haptic" -> { view.performHapticFeedback(CONFIRM_HAPTIC); Outcome.Ok(JSONObject().put("performed", true)) }
                    else -> Outcome.Err("unsupported", "Unknown native bridge operation")
                }
                // A trusted application handshake proves that the current
                // document is interactive, including same-URL reloads whose
                // platform callbacks cannot expose a navigation identity.
                if (outcome is Outcome.Ok && name in setOf("refreshSession", "threadPresence")) {
                    val generation = webGeneration
                    val document = view.url
                    if (document != null) view.evaluateJavascript("Boolean($gatewayReadyProbe && location.href===${JSONObject.quote(document)})") { started ->
                        if (!destroyed && web === view && generation == webGeneration && view.url == document && started == "true") startup?.ready()
                    }
                }
                JSONObject().put("id", id).put("result", outcome.json())
            }
            when (response) { is Outcome.Err -> reply(proxy, id, response); is Outcome.Ok -> if (!response.value.has("deferred")) proxy.postMessage(response.value.toString()) }
        }
        if (!binding.installed) {
            WebViewCompat.addWebMessageListener(view, "KenanNext", setOf(gateway.origin), binding)
            binding.installed = true
        }
    }
    private fun requestAppUpdate() {
        fun status(message: String) { android.widget.Toast.makeText(this, message, android.widget.Toast.LENGTH_LONG).show() }
        status("Checking for an Android update…")
        automaticUpdates.request { outcome -> status(when (outcome) { is Outcome.Ok -> outcome.value.optString("reason", "Confirm the update in Android's prompt"); is Outcome.Err -> outcome.message }) }
    }
    private fun openGateway(gateway: Gateway, destination: String? = null, rendererStopped: Boolean = false) {
        if (!WebViewFeature.isFeatureSupported(WebViewFeature.WEB_MESSAGE_LISTENER)) { AlertDialog.Builder(this).setMessage("This Android WebView lacks the required origin-scoped bridge. Update Android System WebView.").setPositiveButton("OK", null).show(); return }
        setupHeader = null; closeWeb()
        val key = warmKey(gateway)
        val retained = key?.let(WarmPages::take)
        val view = retained?.view ?: WebView(MutableContextWrapper(this))
        (view.context as MutableContextWrapper).baseContext = this
        view.setBackgroundColor(android.graphics.Color.BLACK)
        web = view; warmPageKey = key; webBridge = retained?.bridge ?: WarmPages.Bridge()
        startup = GatewayStartup(view) {
            rendererRecoveries = 0
            val target = view.url?.takeIf { personalDocument(it, gateway) } ?: destination
            openGateway(gateway, target)
        }
        view.settings.javaScriptEnabled = true; view.settings.domStorageEnabled = true
        view.settings.allowFileAccess = false; view.settings.allowContentAccess = false
        view.settings.mixedContentMode = android.webkit.WebSettings.MIXED_CONTENT_NEVER_ALLOW
        CookieManager.getInstance().setAcceptThirdPartyCookies(view, false)
        lastWebSession = sessionCookies(gateway.origin)?.let(::sessionIdentity)
        var bridge = true
        installBridge(view, gateway)
        val capabilityScript = "if(window.KenanNext){window.KenanNext.accountMove=true;window.KenanNext.sessionRefresh=true;window.KenanNext.threadPresence=true;window.KenanNext.nativeNotifications=true;window.KenanNext.foreground=true;window.dispatchEvent(new Event('kenan-native-ready'));}"
        if (retained == null && WebViewFeature.isFeatureSupported(WebViewFeature.DOCUMENT_START_SCRIPT)) WebViewCompat.addDocumentStartJavaScript(view, capabilityScript, setOf(gateway.origin))
        view.webViewClient = object : WebViewClient() {
            override fun shouldInterceptRequest(v: WebView, request: WebResourceRequest) = shares.response(request, gateway.origin)
            override fun shouldOverrideUrlLoading(v: WebView, request: WebResourceRequest): Boolean {
                if (request.isForMainFrame && isAppUpdateDownload(request.url.toString(), embeddedOrigin)) { requestAppUpdate(); return true }
                val parsed = Gateway.parse("${request.url.scheme}://${request.url.authority}")
                if (parsed is Outcome.Ok && parsed.value.origin == gateway.origin) return false
                if (request.isForMainFrame && request.url.scheme in setOf("http", "https")) startActivity(Intent(Intent.ACTION_VIEW, request.url))
                return true
            }
            override fun onPageStarted(v: WebView, url: String, icon: android.graphics.Bitmap?) {
                if (web !== v) return
                startup?.loading(url)
                webGeneration++; NativeThreadPresence.record(this@MainActivity, null); attachments.cancel()
                downloads.cancel(); downloadSource = null
                media?.deny(); media = null; mediaDialog?.dismiss(); mediaDialog = null
                if (bridge && !personalDocument(url, gateway)) { WebViewCompat.removeWebMessageListener(v, "KenanNext"); webBridge?.installed = false; bridge = false }
            }
            override fun onPageCommitVisible(v: WebView, url: String) { if (web === v) startup?.inspect() }
            override fun onReceivedError(v: WebView, request: WebResourceRequest, error: android.webkit.WebResourceError) {
                if (request.isForMainFrame && web === v && (v.url == null || request.url.toString() == v.url))
                    startup?.unreachable({ if (web === v) v.reload() }, document = request.url.toString())
            }
            override fun onReceivedHttpError(v: WebView, request: WebResourceRequest, response: android.webkit.WebResourceResponse) {
                // 502/503/504 come from an edge restart; reload quietly before reporting.
                if (request.isForMainFrame && web === v && (v.url == null || request.url.toString() == v.url)) {
                    if (response.statusCode in setOf(502, 503, 504)) startup?.unreachable({ if (web === v) v.reload() }, document = request.url.toString())
                    else startup?.failed("${APP_LABEL} couldn’t load right now. Try again in a moment.")
                }
            }
            override fun onRenderProcessGone(v: WebView, detail: android.webkit.RenderProcessGoneDetail): Boolean {
                if (web !== v) return true
                val target = v.url?.takeIf { personalDocument(it, gateway) } ?: destination
                startup?.close()
                NativeThreadPresence.record(this@MainActivity, null)
                webBridge?.listener = null
                (v.parent as? ViewGroup)?.removeView(v)
                v.destroy(); web = null; webBridge = null; warmPageKey = null; webGeneration++
                // Recreate only after WebView has delivered the death callback to every shared page.
                window.decorView.post {
                    if (!destroyed) {
                        rendererRecoveries++
                        openGateway(gateway, target, rendererStopped = rendererRecoveries > 1)
                    }
                }
                return true
            }
            override fun onPageFinished(v: WebView, url: String) {
                if (web !== v) return
                startup?.inspect()
                val refreshed = refreshSession(gateway)
                if (refreshed is Outcome.Err) showMessage(refreshed.message)
                if (!bridge && personalDocument(url, gateway)) { installBridge(v, gateway); bridge = true; v.reload() }
                if (bridge) v.evaluateJavascript(capabilityScript, null)
            }
        }
        view.setDownloadListener { url, _, disposition, _, _ ->
            if (isAppUpdateDownload(url, embeddedOrigin)) { requestAppUpdate(); return@setDownloadListener }
            val cookies = sessionCookies(gateway.origin)
            if (!trustedUrl(view.url, gateway) || cookies == null) showMessage("Sign in at the gateway before downloading")
            else if (downloadSource != null) showMessage("Finish selecting the current download destination first")
            else when (val source = downloads.source(url, gateway.origin, cookies, disposition ?: "")) {
                is Outcome.Err -> showMessage(source.message)
                is Outcome.Ok -> {
                    downloadSource = source.value
                    when (val opened = boundary { saveDocument.launch(source.value.fileName); JSONObject() }) {
                        is Outcome.Ok -> Unit
                        is Outcome.Err -> { downloadSource = null; showMessage(opened.message) }
                    }
                }
            }
        }
        view.webChromeClient = object : WebChromeClient() {
            override fun onPermissionRequest(request: PermissionRequest) { runOnUiThread {
                val required = requiredMediaPermissions(request)
                if (!mediaTrusted(request) || "unsupported" in required || media != null) { request.deny(); return@runOnUiThread }
                media = request
                if (required.all { granted(it) }) {
                    if (mediaTrusted(request)) request.grant(request.resources) else request.deny()
                    media = null
                } else mediaPermissions.launch(required.toTypedArray())
            } }
            override fun onPermissionRequestCanceled(request: PermissionRequest) { runOnUiThread { if (media === request) { media = null; mediaDialog?.dismiss(); mediaDialog = null } } }
            override fun onShowFileChooser(v: WebView, callback: ValueCallback<Array<Uri>>, params: FileChooserParams): Boolean {
                if (!trustedUrl(v.url, gateway)) { callback.onReceiveValue(null); return true }
                val generation = webGeneration
                val session = sessionCookies(gateway.origin)!!
                attachments.open(params, callback, sessionIdentity(session)) {
                    !destroyed && generation == webGeneration && web === v && trustedUrl(v.url, gateway) && sessionCookies(gateway.origin) == session
                }
                return true
            }
        }
        if (retained != null) NativeThreadPresence.record(this, retained.presence)
        showGateway(view)
        if (rendererStopped) startup?.failed("${APP_LABEL}’s display stopped. Reload to try again.")
        else if (retained == null) { startup?.loading(); view.loadUrl(destination ?: notificationDestination(intent, gateway) ?: (gateway.origin + "/")) }
        else {
            view.onResume(); view.evaluateJavascript(capabilityScript, null)
            if (key?.target == WarmPages.Target.Main) routeNotice(intent, gateway)
        }
    }
}
