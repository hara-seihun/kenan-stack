package com.example.kenan.android

import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.job.JobInfo
import android.app.job.JobParameters
import android.app.job.JobScheduler
import android.app.job.JobService
import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.os.Build
import okhttp3.OkHttpClient
import okhttp3.Request
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit

class BetaUpdateCheck(private val context: Context, private val origin: String) : AutoCloseable {
    init { require(Gateway.parse(origin) is Outcome.Ok) { "Explicit exact update origin required" } }
    private val client = OkHttpClient.Builder().followRedirects(false).callTimeout(15, TimeUnit.SECONDS).build()
    fun read(): Outcome<ReleaseDecision> {
        if (Build.VERSION.SDK_INT < 28) return Outcome.Err("unsupported", "Verified ${APP_LABEL} updates require Android 9 or newer")
        return try {
            val current = context.packageManager.getPackageInfo(context.packageName, PackageManager.GET_SIGNING_CERTIFICATES)
            val signers = current.signingInfo?.apkContentsSigners
            if (signers == null || signers.size != 1) return Outcome.Err("identity_conflict", "Installed ${APP_LABEL} must have exactly one signer")
            val envelope = client.newCall(Request.Builder().url("$origin/api/android/release").build()).execute().use { response ->
                if (response.code != 200) return Outcome.Err("platform_failure", "${APP_LABEL} update feed returned HTTP ${response.code}")
                val body = response.body ?: return Outcome.Err("platform_failure", "${APP_LABEL} feed has no body")
                body.byteStream().use { stream ->
                    val output = java.io.ByteArrayOutputStream()
                    val buffer = ByteArray(1024)
                    while (output.size() <= 8192) {
                        val count = stream.read(buffer, 0, minOf(buffer.size, 8193 - output.size()))
                        if (count == -1) break
                        output.write(buffer, 0, count)
                    }
                    val bytes = output.toByteArray()
                    if (bytes.size > 8192) return Outcome.Err("invalid_input", "${APP_LABEL} update feed is oversized")
                    String(bytes, Charsets.UTF_8)
                }
            }
            when (val release = BetaRelease.verify(envelope, signers.single().toByteArray())) {
                is Outcome.Err -> release
                is Outcome.Ok -> releaseDecision(release.value, current.longVersionCode)
            }
        } catch (error: Exception) { Outcome.Err("platform_failure", "${APP_LABEL} update check failed: ${error.message ?: error.javaClass.simpleName}") }
    }
    override fun close() { client.dispatcher.cancelAll(); client.dispatcher.executorService.shutdown(); client.connectionPool.evictAll() }
    companion object {
        const val JOB_ID = 4812
        const val NOTICE_ID = 4813
        fun schedule(context: Context): Outcome<Unit> {
            return try {
                val scheduler = context.getSystemService(JobScheduler::class.java)
                val job = JobInfo.Builder(JOB_ID, ComponentName(context, BetaUpdateJob::class.java))
                    .setRequiredNetworkType(JobInfo.NETWORK_TYPE_ANY).setPeriodic(TimeUnit.MINUTES.toMillis(15)).setPersisted(true).build()
                if (scheduler.schedule(job) == JobScheduler.RESULT_SUCCESS) Outcome.Ok(Unit)
                else Outcome.Err("platform_failure", "Android refused periodic ${APP_LABEL} update checks")
            } catch (error: Exception) { Outcome.Err("platform_failure", "${APP_LABEL} update scheduling failed: ${error.javaClass.simpleName}") }
        }
        fun notify(context: Context, release: BetaRelease): Outcome<Unit> {
            if (Build.VERSION.SDK_INT >= 33 && context.checkSelfPermission(android.Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED)
                return Outcome.Err("permission_missing", "${APP_LABEL} ${release.versionName} is available; notification permission is unset. Open ${APP_LABEL} to update.")
            return try {
                val manager = context.getSystemService(NotificationManager::class.java)
                manager.createNotificationChannel(NotificationChannel("beta-updates", "${APP_LABEL} updates", NotificationManager.IMPORTANCE_DEFAULT))
                val pending = PendingIntent.getActivity(context, NOTICE_ID, Intent(context, MainActivity::class.java), PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE)
                manager.notify(NOTICE_ID, android.app.Notification.Builder(context, "beta-updates").setSmallIcon(android.R.drawable.stat_sys_download_done)
                    .setContentTitle("${APP_LABEL} ${release.versionName} is available").setContentText("Open if Android needs confirmation for this update.")
                    .setContentIntent(pending).setAutoCancel(true).setOnlyAlertOnce(true).build())
                Outcome.Ok(Unit)
            } catch (error: Exception) { Outcome.Err("platform_failure", "${APP_LABEL} update notification failed: ${error.javaClass.simpleName}") }
        }
    }
}
class BetaUpdateJob : JobService() {
    private val work = Executors.newSingleThreadExecutor()
    private var cancelled: java.util.concurrent.atomic.AtomicBoolean? = null
    override fun onStartJob(params: JobParameters): Boolean {
        val token = java.util.concurrent.atomic.AtomicBoolean(false); cancelled = token
        work.execute {
            val updateOrigin = accountOrigin(this)
            val reading = BetaUpdateCheck(this, updateOrigin)
            val decision = reading.read(); reading.close()
            if (token.get()) return@execute
            val result = when (decision) {
                is Outcome.Err -> decision
                is Outcome.Ok -> when (val value = decision.value) {
                    ReleaseDecision.Current -> Outcome.Ok(Unit)
                    is ReleaseDecision.Newer -> install(value.release, token, updateOrigin)
                }
            }
            val status = when (result) { is Outcome.Err -> "${result.code}: ${result.message}"; is Outcome.Ok -> "Background update check complete" }
            val saved = getSharedPreferences("kenan-next-device", Context.MODE_PRIVATE).edit().putString("updateCheckStatus", status).commit()
            if (!token.get()) jobFinished(params, !saved || result is Outcome.Err && result.code == "platform_failure")
        }
        return true
    }
    /** The same verified installer as foreground updates; Android alone decides whether consent is needed. */
    private fun install(release: BetaRelease, token: java.util.concurrent.atomic.AtomicBoolean, updateOrigin: String): Outcome<Unit> {
        if (!packageManager.canRequestPackageInstalls()) return BetaUpdateCheck.notify(this, release)
        val prefs = getSharedPreferences("kenan-next-device", Context.MODE_PRIVATE)
        val custody = InstallerCustody(prefs)
        val installed = androidx.core.content.pm.PackageInfoCompat.getLongVersionCode(packageManager.getPackageInfo(packageName, 0))
        val prior = when (val read = custody.read()) { is Outcome.Err -> return read; is Outcome.Ok -> read.value }
        val record = when (prior) {
            is InstallerRecord.Installed -> { if (installed >= prior.version) custody.clear(); InstallerRecord.Clear }
            is InstallerRecord.Submitted -> if (installed >= prior.version) { custody.clear(); InstallerRecord.Clear } else prior
            else -> prior
        }
        // Resolve a completed install first, even if its final callback was lost when Android replaced the app.
        if (record is InstallerRecord.Submitted && prefs.getString("autoUpdateState", null) == "awaiting-android-consent") return BetaUpdateCheck.notify(this, release)
        if (UpdatePolicy.plan(UpdateTrigger.Automatic, record, System.currentTimeMillis()) is UpdatePlan.Hold) return Outcome.Ok(Unit)
        val updater = ApkUpdater(this)
        val prepared = updater.prepare(release.download(updateOrigin), updateOrigin, "")
        if (prepared is Outcome.Err) return prepared
        val submitted = updater.install((prepared as Outcome.Ok).value) { !token.get() }
        if (submitted is Outcome.Err) return submitted
        return Outcome.Ok(Unit)
    }
    override fun onStopJob(params: JobParameters): Boolean { cancelled?.set(true); return true }
    override fun onDestroy() { cancelled?.set(true); work.shutdown(); super.onDestroy() }
}
