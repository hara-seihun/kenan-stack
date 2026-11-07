package com.example.kenan.android

import android.Manifest
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.content.pm.PackageManager
import android.net.ConnectivityManager
import android.net.LinkProperties
import android.net.Network
import android.net.NetworkCapabilities
import android.net.NetworkRequest
import android.net.wifi.ScanResult
import android.net.wifi.WifiInfo
import android.net.wifi.WifiManager
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.os.PowerManager
import android.provider.Settings
import android.webkit.CookieManager
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
import java.util.concurrent.TimeUnit

/**
 * Records what the phone's networks do (default-network moves, Wi-Fi association, band, MLO links, validation, signal,
 * nearby access points, screen and doze changes, the notification stream's state) and sends it to the person's server,
 * over whatever network works, so her agents can diagnose drops without a cable or Wireless debugging. SSID, BSSID and
 * scans need location permission; without it those fields are absent and the rest still reports.
 */
object NetworkDiag {
    private const val SNAPSHOT_MS = 15 * 60_000L
    private const val MAX_PENDING = 3_000
    private val main = Handler(Looper.getMainLooper())
    private val client = OkHttpClient.Builder().connectTimeout(20, TimeUnit.SECONDS).readTimeout(30, TimeUnit.SECONDS).build()
    private val pending = ArrayDeque<JSONObject>()
    private var sending = false
    private var started = false
    private lateinit var app: Context
    /** Last recorded form of each network's state, so unchanged callbacks don't repeat. */
    private val lastState = HashMap<String, String>()

    /** Diagnostics must never take the app down: every entry point runs through here, and a failure becomes a recorded error. */
    private fun guard(where: String, block: () -> Unit) {
        try { block() } catch (e: Throwable) {
            runCatching { record(JSONObject().put("kind", "error").put("where", where).put("error", e.toString())) }
        }
    }

    fun start(context: Context) {
        if (started) return
        started = true
        app = context.applicationContext
        guard("start") { begin() }
    }

    private fun begin() {
        val cm = app.getSystemService(ConnectivityManager::class.java)
        val info = app.packageManager.getPackageInfo(app.packageName, 0)
        record(JSONObject().put("kind", "start").put("app", BuildConfig.VERSION_NAME)
            .put("firstInstallAt", info.firstInstallTime).put("lastUpdateAt", info.lastUpdateTime)
            .put("deviceId", app.getSharedPreferences("kenan-next-device", Context.MODE_PRIVATE).getString("deviceId", null)).put("sdk", Build.VERSION.SDK_INT)
            .put("device", "${Build.MANUFACTURER} ${Build.MODEL}").put("build", Build.DISPLAY).put("permissions", permissions()).put("settings", settings()).put("texts", Texts.status(app)))
        cm.registerDefaultNetworkCallback(watcher("default"))
        val wifi = NetworkRequest.Builder().addTransportType(NetworkCapabilities.TRANSPORT_WIFI).removeCapability(NetworkCapabilities.NET_CAPABILITY_NOT_VPN).build()
        if (Build.VERSION.SDK_INT >= 31) cm.registerNetworkCallback(wifi, watcher("wifi", ConnectivityManager.NetworkCallback.FLAG_INCLUDE_LOCATION_INFO))
        else cm.registerNetworkCallback(wifi, watcher("wifi"))
        cm.registerNetworkCallback(NetworkRequest.Builder().addTransportType(NetworkCapabilities.TRANSPORT_CELLULAR).build(), watcher("cellular"))
        val filter = IntentFilter().apply {
            addAction(Intent.ACTION_SCREEN_ON); addAction(Intent.ACTION_SCREEN_OFF)
            addAction(PowerManager.ACTION_DEVICE_IDLE_MODE_CHANGED); addAction(PowerManager.ACTION_POWER_SAVE_MODE_CHANGED)
            @Suppress("DEPRECATION") addAction(WifiManager.NETWORK_STATE_CHANGED_ACTION)
            addAction(WifiManager.WIFI_STATE_CHANGED_ACTION)
        }
        val receiver = object : BroadcastReceiver() {
            override fun onReceive(context: Context, intent: Intent) { main.post { guard("broadcast") { broadcast(intent) } } }
        }
        if (Build.VERSION.SDK_INT >= 33) app.registerReceiver(receiver, filter, Context.RECEIVER_EXPORTED) else app.registerReceiver(receiver, filter)
        main.post(snapshotLoop)
    }

    /** Free-form app-side events (the notification stream connecting or failing). */
    fun note(kind: String, detail: String) { if (started) main.post { guard("note") { record(JSONObject().put("kind", kind).put("detail", detail)) } } }

    private val snapshotLoop = object : Runnable {
        override fun run() {
            guard("snapshot") { PhoneLocation.start(app); record(snapshot()) }
            guard("flush") { flush() }
            main.postDelayed(this, SNAPSHOT_MS)
        }
    }

    private fun watcher(name: String, flags: Int? = null): ConnectivityManager.NetworkCallback {
        return if (flags != null && Build.VERSION.SDK_INT >= 31) Watcher(name, flags) else Watcher(name)
    }

    private class Watcher : ConnectivityManager.NetworkCallback {
        val name: String
        constructor(name: String) : super() { this.name = name }
        @androidx.annotation.RequiresApi(31) constructor(name: String, flags: Int) : super(flags) { this.name = name }
        private fun later(what: String, block: () -> Unit) { main.post { guard("$name/$what", block) } }
        override fun onAvailable(network: Network) = later("available") { event(name, "available", network) }
        override fun onLost(network: Network) = later("lost") { lastState.remove("$name/$network"); event(name, "lost", network); soon() }
        override fun onLosing(network: Network, maxMsToLive: Int) = later("losing") { event(name, "losing", network, JSONObject().put("maxMsToLive", maxMsToLive)) }
        override fun onUnavailable() = later("unavailable") { record(JSONObject().put("kind", name).put("event", "unavailable")) }
        override fun onBlockedStatusChanged(network: Network, blocked: Boolean) = later("blocked") { event(name, "blocked", network, JSONObject().put("blocked", blocked)) }
        override fun onCapabilitiesChanged(network: Network, caps: NetworkCapabilities) {
            val state = try { capabilities(caps) } catch (e: Throwable) { later("capabilities") { throw e }; return }
            later("capabilities") {
                val key = "$name/$network"; val text = state.toString()
                if (lastState[key] == text) return@later
                val before = lastState[key]?.let { JSONObject(it) }
                lastState[key] = text
                event(name, "capabilities", network, state)
                if (before != null && before.optBoolean("validated") != state.optBoolean("validated")) soon()
            }
        }
        override fun onLinkPropertiesChanged(network: Network, link: LinkProperties) = later("link") {
            val state = linkJson(link); val key = "$name/$network/link"; val text = state.toString()
            if (lastState[key] != text) { lastState[key] = text; event(name, "link", network, state) }
        }
    }

    /** Only connection failures send diagnostics promptly; normal radio changes are batched. */
    private fun soon() { main.removeCallbacks(soonFlush); main.postDelayed(soonFlush, 5_000) }
    private val soonFlush = Runnable { guard("snapshot") { record(snapshot()) }; guard("flush") { flush() } }

    private fun event(name: String, what: String, network: Network, extra: JSONObject? = null) =
        record((extra ?: JSONObject()).put("kind", name).put("event", what).put("network", network.toString()))

    private fun capabilities(caps: NetworkCapabilities): JSONObject {
        val transports = listOf(NetworkCapabilities.TRANSPORT_WIFI to "wifi", NetworkCapabilities.TRANSPORT_CELLULAR to "cellular",
            NetworkCapabilities.TRANSPORT_VPN to "vpn", NetworkCapabilities.TRANSPORT_ETHERNET to "ethernet").filter { caps.hasTransport(it.first) }.map { it.second }
        val out = JSONObject().put("transports", JSONArray(transports))
            .put("validated", caps.hasCapability(NetworkCapabilities.NET_CAPABILITY_VALIDATED))
            .put("internet", caps.hasCapability(NetworkCapabilities.NET_CAPABILITY_INTERNET))
            .put("captive", caps.hasCapability(NetworkCapabilities.NET_CAPABILITY_CAPTIVE_PORTAL))
            .put("notMetered", caps.hasCapability(NetworkCapabilities.NET_CAPABILITY_NOT_METERED))
            .put("downKbps", caps.linkDownstreamBandwidthKbps).put("upKbps", caps.linkUpstreamBandwidthKbps)
        if (Build.VERSION.SDK_INT >= 29) out.put("signal", caps.signalStrength)
        if (Build.VERSION.SDK_INT >= 31) (caps.transportInfo as? WifiInfo)?.let { out.put("wifi", wifiInfo(it, coarse = true)) }
        return out
    }

    private fun linkJson(link: LinkProperties): JSONObject {
        val out = JSONObject().put("iface", link.interfaceName ?: JSONObject.NULL)
            .put("addresses", JSONArray(link.linkAddresses.map { it.toString() }))
            .put("dns", JSONArray(link.dnsServers.mapNotNull { it.hostAddress }))
        if (Build.VERSION.SDK_INT >= 28) out.put("privateDns", link.isPrivateDnsActive).put("privateDnsServer", link.privateDnsServerName ?: JSONObject.NULL)
        if (Build.VERSION.SDK_INT >= 29) out.put("mtu", link.mtu)
        return out
    }

    /** coarse: only fields that change on association or band moves, so capability callbacks don't repeat for RSSI. */
    private fun wifiInfo(info: WifiInfo, coarse: Boolean): JSONObject {
        val out = JSONObject().put("ssid", info.ssid).put("bssid", info.bssid ?: JSONObject.NULL).put("freq", info.frequency)
            .put("band", band(info.frequency)).put("networkId", info.networkId)
        if (Build.VERSION.SDK_INT >= 30) out.put("standard", standard(info.wifiStandard))
        if (Build.VERSION.SDK_INT >= 33) out.put("apMld", info.apMldMacAddress?.toString() ?: JSONObject.NULL).put("mloLinkId", info.apMloLinkId)
        if (Build.VERSION.SDK_INT >= 34) {
            out.put("mloLinks", JSONArray(info.associatedMloLinks.map { l ->
                JSONObject().put("id", l.linkId).put("band", mloBand(l.band)).put("channel", l.channel).put("ap", l.apMacAddress?.toString() ?: JSONObject.NULL).put("state", mloState(l.state))
            }))
        }
        if (coarse) return out
        out.put("rssi", info.rssi).put("linkMbps", info.linkSpeed)
        if (Build.VERSION.SDK_INT >= 29) out.put("txMbps", info.txLinkSpeedMbps).put("rxMbps", info.rxLinkSpeedMbps)
        if (Build.VERSION.SDK_INT >= 31) out.put("security", info.currentSecurityType)
        if (Build.VERSION.SDK_INT >= 33) out.put("affiliatedLinks", JSONArray(info.affiliatedMloLinks.map { l ->
            JSONObject().put("id", l.linkId).put("band", mloBand(l.band)).put("channel", l.channel).put("state", mloState(l.state))
        }))
        return out
    }

    private fun snapshot(): JSONObject {
        val cm = app.getSystemService(ConnectivityManager::class.java)
        val wm = app.getSystemService(WifiManager::class.java)
        val pm = app.getSystemService(PowerManager::class.java)
        val out = JSONObject().put("kind", "snapshot").put("wifiEnabled", wm.isWifiEnabled).put("location", PhoneLocation.status(app))
            .put("battery", BatteryDiag.snapshot(app)).put("texts", Texts.status(app)).put("idle", pm.isDeviceIdleMode).put("powerSave", pm.isPowerSaveMode).put("interactive", pm.isInteractive)
        val active = cm.activeNetwork
        out.put("default", active?.let { n -> cm.getNetworkCapabilities(n)?.let { capabilities(it).put("network", n.toString()) } } ?: JSONObject.NULL)
        @Suppress("DEPRECATION") val all = cm.allNetworks
        out.put("networks", JSONArray(all.mapNotNull { n -> cm.getNetworkCapabilities(n)?.let { capabilities(it).put("network", n.toString()) } }))
        @Suppress("DEPRECATION") wm.connectionInfo?.let { out.put("wifi", wifiInfo(it, coarse = false)) }
        if (located()) {
            val current = (out.optJSONObject("wifi")?.optString("ssid") ?: "").trim('"')
            val scans = runCatching { wm.scanResults }.getOrNull().orEmpty()
            out.put("scan", JSONArray(scans.sortedWith(compareByDescending<ScanResult> { ssidOf(it) == current }.thenByDescending { it.level }).take(30).map { s ->
                JSONObject().put("ssid", ssidOf(s)).put("bssid", s.BSSID).put("freq", s.frequency).put("band", band(s.frequency)).put("level", s.level)
                    .put("width", s.channelWidth).put("ageMs", (android.os.SystemClock.elapsedRealtime() * 1000 - s.timestamp) / 1000)
                    .also { if (Build.VERSION.SDK_INT >= 30) it.put("standard", standard(s.wifiStandard)) }
                    .also { if (Build.VERSION.SDK_INT >= 34) it.put("apMld", s.apMldMacAddress?.toString() ?: JSONObject.NULL) }
            }))
        }
        return out
    }

    @Suppress("DEPRECATION")
    private fun ssidOf(s: ScanResult): String = if (Build.VERSION.SDK_INT >= 33) (s.wifiSsid?.toString() ?: "").trim('"') else s.SSID

    private fun broadcast(intent: Intent) {
        val out = JSONObject().put("kind", "broadcast").put("action", intent.action?.substringAfterLast('.') ?: JSONObject.NULL)
        @Suppress("DEPRECATION")
        when (intent.action) {
            WifiManager.NETWORK_STATE_CHANGED_ACTION -> {
                val info = if (Build.VERSION.SDK_INT >= 33) intent.getParcelableExtra(WifiManager.EXTRA_NETWORK_INFO, android.net.NetworkInfo::class.java) else intent.getParcelableExtra(WifiManager.EXTRA_NETWORK_INFO)
                val detail = info?.detailedState?.name ?: "unknown"
                if (lastState["wifi-detailed"] == detail) return
                lastState["wifi-detailed"] = detail
                out.put("state", detail).put("reason", info?.reason ?: JSONObject.NULL)
                if (info?.detailedState == android.net.NetworkInfo.DetailedState.DISCONNECTED) soon()
            }
            WifiManager.WIFI_STATE_CHANGED_ACTION -> out.put("state", intent.getIntExtra(WifiManager.EXTRA_WIFI_STATE, -1))
            PowerManager.ACTION_DEVICE_IDLE_MODE_CHANGED -> out.put("idle", app.getSystemService(PowerManager::class.java).isDeviceIdleMode)
            PowerManager.ACTION_POWER_SAVE_MODE_CHANGED -> out.put("powerSave", app.getSystemService(PowerManager::class.java).isPowerSaveMode)
        }
        record(out)
    }

    private fun record(entry: JSONObject) {
        entry.put("t", System.currentTimeMillis())
        pending.addLast(entry)
        while (pending.size > MAX_PENDING) pending.removeFirst()
    }

    private fun flush() {
        if (sending || pending.isEmpty()) return
        val origin = accountOrigin(app)
        val cookies = CookieManager.getInstance().getCookie(origin) ?: return
        val batch = ArrayList<JSONObject>(); var bytes = 0
        for (e in pending) { val n = e.toString().length; if (batch.isNotEmpty() && bytes + n > 400_000) break; batch.add(e); bytes += n }
        sending = true
        BatteryDiag.count("diagnosticUpload")
        val body = JSONObject().put("entries", JSONArray(batch)).toString().toRequestBody("application/json".toMediaType())
        client.newCall(Request.Builder().url("$origin/api/ext/phone-settings/network").header("Cookie", cookies).header("x-kenan-client", "native").post(body).build())
            .enqueue(object : Callback {
                override fun onFailure(call: Call, e: IOException) { main.post { sending = false } }
                override fun onResponse(call: Call, response: Response) {
                    val sent = runCatching { response.use { it.isSuccessful } }.getOrDefault(false)
                    main.post {
                        sending = false
                        if (sent) repeat(batch.size) { if (pending.isNotEmpty() && pending.first() === batch[it]) pending.removeFirst() }
                    }
                }
            })
    }

    private fun located() = app.checkSelfPermission(Manifest.permission.ACCESS_FINE_LOCATION) == PackageManager.PERMISSION_GRANTED

    private fun permissions() = JSONObject().apply {
        (listOf(Manifest.permission.ACCESS_FINE_LOCATION, Manifest.permission.READ_LOGS, Manifest.permission.DUMP, Manifest.permission.PACKAGE_USAGE_STATS,
            Manifest.permission.WRITE_SECURE_SETTINGS) + if (Build.VERSION.SDK_INT >= 29) listOf(Manifest.permission.ACCESS_BACKGROUND_LOCATION) else emptyList())
            .forEach { put(it.substringAfterLast('.'), app.checkSelfPermission(it) == PackageManager.PERMISSION_GRANTED) }
    }

    private fun settings() = JSONObject().apply {
        mapOf("location_mode" to { Settings.Secure.getString(app.contentResolver, Settings.Secure.LOCATION_MODE) },
            "adb_wifi_enabled" to { Settings.Global.getString(app.contentResolver, "adb_wifi_enabled") })
            .forEach { (k, read) -> put(k, runCatching { read() ?: JSONObject.NULL }.getOrElse { "unreadable" }) }
    }

    private fun band(freq: Int) = when (freq) { in 2400..2500 -> "2.4"; in 4900..5900 -> "5"; in 5925..7125 -> "6"; else -> "?" }
    private fun mloBand(b: Int) = when (b) { 1 -> "2.4"; 2 -> "5"; 8 -> "6"; else -> b.toString() }
    private fun mloState(s: Int) = when (s) { 1 -> "unassociated"; 2 -> "idle"; 3 -> "active"; else -> "invalid" }
    private fun standard(s: Int) = when (s) { 1 -> "legacy"; 4 -> "11n"; 5 -> "11ac"; 6 -> "11ax"; 7 -> "11ad"; 8 -> "11be"; else -> "unknown" }
}
