package com.example.kenan.android

import android.Manifest
import android.app.PendingIntent
import android.app.job.JobInfo
import android.app.job.JobParameters
import android.app.job.JobScheduler
import android.app.job.JobService
import android.content.BroadcastReceiver
import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.location.Location
import android.location.LocationListener
import android.location.LocationRequest
import android.location.LocationManager
import android.net.wifi.WifiManager
import android.os.Build
import android.os.CancellationSignal
import android.os.Handler
import android.os.Looper
import android.os.SystemClock
import android.webkit.CookieManager
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import org.json.JSONObject
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit

internal fun locationExpired(measuredAt: Long, now: Long) = measuredAt <= 0 || now - measuredAt > 30L * 24 * 60 * 60 * 1000

internal fun locationPayload(latitude: Double, longitude: Double, accuracy: Double, measuredAt: Long) = JSONObject().put("latitude", latitude).put("longitude", longitude).put("accuracy", accuracy).put("measuredAt", measuredAt)

/** One persisted unsent fix, so a long outage cannot build an unbounded queue. */
object PhoneLocation {
    private const val PERIODIC = 91301
    private const val RETRY = 91302
    private const val IMMEDIATE = 91303
    private const val SIX_HOURS = 6 * 60 * 60 * 1000L
    private const val ACTIVE_REFRESH = 2 * 60_000L
    private const val MAX_FIX_AGE = 2 * 60_000L
    private val handler = Handler(Looper.getMainLooper())
    @Volatile private var active: Context? = null
    private var refreshing = false
    private val activeTick = object : Runnable {
        override fun run() {
            val app = active ?: return
            register(app)
            refresh(app) {}
            handler.postDelayed(this, ACTIVE_REFRESH)
        }
    }
    // Handler timers do not wake a sleeping phone. Foreground provider updates deliver movement fixes.
    fun serviceStarted(c: Context) {
        if (active != null) return
        active = c.applicationContext
        registeredPermissions = null
        start(c)
        handler.post(activeTick)
    }
    fun serviceStopped(c: Context) {
        active = null
        handler.removeCallbacks(activeTick)
        registeredPermissions = null
        register(c.applicationContext)
    }
    private val worker = Executors.newSingleThreadExecutor()
    private val http = OkHttpClient.Builder().callTimeout(25, TimeUnit.SECONDS).build()
    private fun prefs(c: Context) = c.getSharedPreferences("phone-location", Context.MODE_PRIVATE)
    fun foregroundGranted(c: Context) = c.checkSelfPermission(Manifest.permission.ACCESS_FINE_LOCATION) == PackageManager.PERMISSION_GRANTED || c.checkSelfPermission(Manifest.permission.ACCESS_COARSE_LOCATION) == PackageManager.PERMISSION_GRANTED
    fun backgroundGranted(c: Context) = Build.VERSION.SDK_INT < 29 || c.checkSelfPermission(Manifest.permission.ACCESS_BACKGROUND_LOCATION) == PackageManager.PERMISSION_GRANTED
    private fun intent(c: Context): PendingIntent = PendingIntent.getBroadcast(c, 91401, Intent(c, PhoneLocationReceiver::class.java), PendingIntent.FLAG_UPDATE_CURRENT or if (Build.VERSION.SDK_INT >= 31) PendingIntent.FLAG_MUTABLE else 0)
    fun status(c: Context): JSONObject {
        val lm = c.getSystemService(LocationManager::class.java)
        val last = prefs(c).getLong("lastFixAt", 0)
        return JSONObject().put("fineGranted", c.checkSelfPermission(Manifest.permission.ACCESS_FINE_LOCATION) == PackageManager.PERMISSION_GRANTED)
            .put("backgroundGranted", backgroundGranted(c)).put("enabled", if (Build.VERSION.SDK_INT >= 28) lm.isLocationEnabled else android.provider.Settings.Secure.getInt(c.contentResolver, android.provider.Settings.Secure.LOCATION_MODE, 0) != 0)
            .put("lastFixAt", if (last > 0) last else JSONObject.NULL)
    }
    private var registeredPermissions: Int? = null
    private fun scheduler(c: Context) = c.getSystemService(JobScheduler::class.java)
    fun start(c: Context, prompt: Boolean = false) {
        val app = c.applicationContext
        if (scheduler(app).getPendingJob(PERIODIC) == null) scheduler(app).schedule(JobInfo.Builder(PERIODIC, ComponentName(app, PhoneLocationJob::class.java)).setPeriodic(SIX_HOURS).setPersisted(true).build())
        val granted = foregroundGranted(app) && backgroundGranted(app)
        val wasGranted = prefs(app).getBoolean("granted", false)
        prefs(app).edit().putBoolean("granted", granted).apply()
        register(app)
        val now = System.currentTimeMillis()
        val last = prefs(app).getLong("lastFixAt", 0)
        val lastAttempt = prefs(app).getLong("refreshAttemptAt", 0)
        if (granted && (!wasGranted || (now - last >= SIX_HOURS && now - lastAttempt >= 5 * 60_000L))) {
            prefs(app).edit().putLong("refreshAttemptAt", now).apply()
            scheduler(app).schedule(JobInfo.Builder(IMMEDIATE, ComponentName(app, PhoneLocationJob::class.java)).build())
        }
        if (prompt) refresh(app) {}
        if (prefs(app).contains("pending") && scheduler(app).getPendingJob(RETRY) == null) retry(app)
    }
    private fun provider(lm: LocationManager): String? = when {
        Build.VERSION.SDK_INT >= 31 && lm.allProviders.contains(LocationManager.FUSED_PROVIDER) -> LocationManager.FUSED_PROVIDER
        lm.allProviders.contains(LocationManager.NETWORK_PROVIDER) -> LocationManager.NETWORK_PROVIDER
        lm.allProviders.contains(LocationManager.GPS_PROVIDER) -> LocationManager.GPS_PROVIDER
        else -> null
    }
    @Synchronized fun register(c: Context) {
        val lm = c.getSystemService(LocationManager::class.java)
        if (!foregroundGranted(c) || !backgroundGranted(c)) { runCatching { lm.removeUpdates(intent(c)) }; registeredPermissions = null; return }
        val permission = (if (c.checkSelfPermission(Manifest.permission.ACCESS_FINE_LOCATION) == PackageManager.PERMISSION_GRANTED) 1 else 0) + (if (active != null) 2 else 0)
        if (registeredPermissions == permission) return
        try {
            lm.removeUpdates(intent(c))
            val provider = provider(lm) ?: return
            if (Build.VERSION.SDK_INT >= 31) {
                val request = LocationRequest.Builder(if (active != null) 60_000L else 15 * 60_000L)
                    .setQuality(if (active != null) LocationRequest.QUALITY_HIGH_ACCURACY else LocationRequest.QUALITY_BALANCED_POWER_ACCURACY)
                    .setMinUpdateIntervalMillis(30_000L).setMinUpdateDistanceMeters(if (active != null) 25f else 100f)
                    .setMaxUpdateDelayMillis(0).build()
                lm.requestLocationUpdates(provider, request, intent(c))
            } else lm.requestLocationUpdates(provider, if (active != null) 60_000L else 15 * 60_000L, if (active != null) 25f else 100f, intent(c))
            registeredPermissions = permission
        } catch (e: SecurityException) {
            registeredPermissions = null
            runCatching { lm.removeUpdates(intent(c)) }
            android.util.Log.w("PhoneLocation", "Location update permission unavailable", e)
        } catch (e: IllegalArgumentException) {
            registeredPermissions = null
            android.util.Log.w("PhoneLocation", "Location provider unavailable", e)
        }
    }
    fun refresh(c: Context, finished: () -> Unit) {
        val app = c.applicationContext
        handler.post {
            if (refreshing || !foregroundGranted(app) || !backgroundGranted(app)) { finished(); return@post }
            val lm = app.getSystemService(LocationManager::class.java)
            val provider = provider(lm) ?: run { finished(); return@post }
            refreshing = true
            val cancellation = CancellationSignal()
            var listener: LocationListener? = null
            var complete = false
            lateinit var timeout: Runnable
            fun done(fix: Location?) {
                if (complete) return
                complete = true
                refreshing = false
                handler.removeCallbacks(timeout)
                cancellation.cancel()
                listener?.let { runCatching { lm.removeUpdates(it) } }
                if (fix != null) accept(app, fix, finished) else finished()
            }
            timeout = Runnable { done(null) }
            handler.postDelayed(timeout, 20_000L)
            try {
                if (Build.VERSION.SDK_INT >= 31) {
                    // A short balanced request covers the time trigger even when the movement
                    // registration's distance threshold isn't crossed. No continuous GPS polling.
                    val request = LocationRequest.Builder(0).setQuality(LocationRequest.QUALITY_BALANCED_POWER_ACCURACY).setDurationMillis(20_000).build()
                    lm.getCurrentLocation(provider, request, cancellation, { handler.post(it) }) { done(it) }
                } else if (Build.VERSION.SDK_INT >= 30) lm.getCurrentLocation(provider, cancellation, { handler.post(it) }) { done(it) }
                else {
                    listener = object : LocationListener {
                        override fun onLocationChanged(location: Location) { done(location) }
                        override fun onProviderEnabled(provider: String) {}
                        override fun onProviderDisabled(provider: String) { done(null) }
                        @Deprecated("Platform callback") override fun onStatusChanged(provider: String?, status: Int, extras: android.os.Bundle?) {}
                    }
                    @Suppress("DEPRECATION")
                    lm.requestSingleUpdate(provider, listener!!, Looper.getMainLooper())
                }
            } catch (e: SecurityException) {
                android.util.Log.w("PhoneLocation", "Location refresh permission unavailable", e)
                done(null)
            } catch (e: IllegalArgumentException) {
                android.util.Log.w("PhoneLocation", "Location refresh provider unavailable", e)
                done(null)
            }
        }
    }
    fun accept(c: Context, location: Location, finished: () -> Unit = {}) {
        val app = c.applicationContext
        if (!foregroundGranted(app) || !backgroundGranted(app) || !location.hasAccuracy() || location.time <= 0) { finished(); return }
        // Current Wi-Fi describes this fix only when the fix was just measured.
        val age = (SystemClock.elapsedRealtimeNanos() - location.elapsedRealtimeNanos) / 1_000_000L
        if (age < 0 || age > MAX_FIX_AGE) { finished(); return }
        @Suppress("DEPRECATION")
        val ssid = if (age <= 30_000L) runCatching { app.getSystemService(WifiManager::class.java).connectionInfo.ssid }.getOrNull()?.trim('"') else null
        worker.execute {
          try {
            if (!foregroundGranted(app) || !backgroundGranted(app)) return@execute
            if ((SystemClock.elapsedRealtimeNanos() - location.elapsedRealtimeNanos) / 1_000_000L > MAX_FIX_AGE) return@execute
            if (location.time <= prefs(app).getLong("lastFixAt", 0)) return@execute
            val body = locationPayload(location.latitude, location.longitude, location.accuracy.toDouble(), location.time)
            if (!ssid.isNullOrBlank() && ssid != "<unknown ssid>") body.put("wifiSsid", ssid)
            val old = prefs(app).getString("pending", null)?.let { runCatching { JSONObject(it).optLong("measuredAt") }.getOrNull() } ?: 0
            if (location.time < old) return@execute
            prefs(app).edit().putLong("lastFixAt", location.time).putString("pending", body.toString()).commit()
            send(app)
          } finally { finished() }
        }
    }
    private fun retry(c: Context) {
        scheduler(c).schedule(JobInfo.Builder(RETRY, ComponentName(c, PhoneLocationJob::class.java)).setRequiredNetworkType(JobInfo.NETWORK_TYPE_ANY).setMinimumLatency(15 * 60_000L).setOverrideDeadline(6 * 60 * 60_000L).build())
    }
    fun flush(c: Context, finished: () -> Unit = {}) { worker.execute { try { send(c.applicationContext) } finally { finished() } } }
    private fun send(c: Context) {
        if (!foregroundGranted(c) || !backgroundGranted(c)) { prefs(c).edit().remove("pending").apply(); return }
        val pending = prefs(c).getString("pending", null) ?: return
        val measuredAt = runCatching { JSONObject(pending).getLong("measuredAt") }.getOrDefault(0)
        if (measuredAt < prefs(c).getLong("lastFixAt", 0) || locationExpired(measuredAt, System.currentTimeMillis())) { prefs(c).edit().remove("pending").apply(); return }
        val origin = accountOrigin(c)
        val cookies = CookieManager.getInstance().getCookie(origin)
        if (cookies == null) { retry(c); return }
        val ok = runCatching { http.newCall(Request.Builder().url("$origin/api/ext/phone-settings/location").header("Cookie", cookies).header("x-kenan-client", "native").post(pending.toRequestBody("application/json".toMediaType())).build()).execute().use { it.isSuccessful } }.getOrDefault(false)
        if (ok) { if (prefs(c).getString("pending", null) == pending) prefs(c).edit().remove("pending").apply() } else retry(c)
    }
}

class PhoneLocationReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        @Suppress("DEPRECATION") val location = intent.getParcelableExtra<Location>(LocationManager.KEY_LOCATION_CHANGED)
        if (location != null) { val pending = goAsync(); PhoneLocation.accept(context, location) { pending.finish() } }
    }
}
class PhoneLocationJob : JobService() {
    override fun onStartJob(params: JobParameters): Boolean {
        PhoneLocation.register(this)
        PhoneLocation.flush(this) {
            if (params.jobId == 91301 || params.jobId == 91303) PhoneLocation.refresh(this) { jobFinished(params, false) }
            else jobFinished(params, false)
        }
        return true
    }
    override fun onStopJob(params: JobParameters) = false
}
