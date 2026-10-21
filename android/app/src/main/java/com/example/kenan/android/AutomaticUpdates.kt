package com.example.kenan.android

import android.content.Context
import android.content.Intent
import android.net.Uri
import android.os.Handler
import android.os.Looper
import android.provider.Settings
import org.json.JSONObject
import java.io.File
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit

/** The app's one update path. Automatic checks run only while the app is in the foreground and follow
 * [UpdatePolicy]; a request (the Install update banner, an app link, setup's retry) always submits. */
class AutomaticUpdates(private val activity: MainActivity, private val origin: String, private val report: (String) -> Unit) : AutoCloseable {
    private val prefs = activity.getSharedPreferences("kenan-next-device", Context.MODE_PRIVATE)
    private val custody = InstallerCustody(prefs)
    private val worker = Executors.newSingleThreadExecutor()
    private val handler = Handler(Looper.getMainLooper())
    private val check = BetaUpdateCheck(activity, origin)
    @Volatile private var active = false
    private var busy = false
    private val requests = mutableListOf<(Outcome<JSONObject>) -> Unit>()
    @Volatile private var closed = false
    private val staged = java.util.concurrent.atomic.AtomicReference<File?>(null)
    private val tick = Runnable { inspect() }

    fun resume() {
        active = true; UpdateConsent.foreground = true
        val current = (custody.read() as? Outcome.Ok)?.value as? InstallerRecord.Submitted
        if (UpdateConsent.showHeld(activity, current?.session)) return
        inspect()
    }
    fun pause() { active = false; UpdateConsent.foreground = false; handler.removeCallbacks(tick) }
    /** A person asked for the update: submit it now, whatever was declined or batched before. */
    fun request(onOutcome: (Outcome<JSONObject>) -> Unit) {
        requests += onOutcome
        if (busy) return
        inspect()
    }
    private fun record(status: String) {
        if (prefs.edit().putString("updateCheckStatus", status).commit()) report(status)
        else report("storage_failure: Update status could not be saved")
    }
    private fun inspect() {
        if (closed || busy) return
        val answering = requests.toList(); requests.clear()
        val trigger = if (answering.isEmpty()) UpdateTrigger.Automatic else UpdateTrigger.Requested
        if (trigger == UpdateTrigger.Automatic && !active) return
        busy = true
        handler.removeCallbacks(tick)
        worker.execute {
            val result = nativeAttempt { check.read() }
            handler.post {
                if (closed) return@post
                val observation = nativeAttempt { decide(trigger, result, answering); Outcome.Ok(Unit) }
                if (observation is Outcome.Err) finish(observation, answering)
            }
        }
    }
    private fun decide(trigger: UpdateTrigger, result: Outcome<ReleaseDecision>, answering: List<(Outcome<JSONObject>) -> Unit>) {
        val decision = when (result) { is Outcome.Err -> return finish(result, answering); is Outcome.Ok -> result.value }
        val installed = activity.packageManager.getPackageInfo(activity.packageName, 0).longVersionCode
        val record = when (val read = custody.read()) {
            is Outcome.Ok -> read.value
            is Outcome.Err -> { if (!custody.clear()) return finish(Outcome.Err("storage_failure", "Installer record could not be reset"), answering); InstallerRecord.Clear }
        }
        val settledVersion = when (record) {
            InstallerRecord.Clear -> null
            is InstallerRecord.Submitted -> record.version
            is InstallerRecord.Declined -> record.version
            is InstallerRecord.Failed -> record.version
            is InstallerRecord.Installed -> record.version
        }
        val current = if (settledVersion != null && installed >= settledVersion) {
            if (!custody.clear()) return finish(Outcome.Err("storage_failure", "Completed update custody could not be released"), answering)
            InstallerRecord.Clear
        } else record
        val release = when (decision) {
            ReleaseDecision.Current -> return finish(Outcome.Ok(JSONObject().put("state", "current").put("versionCode", installed)), answering, "${APP_LABEL} is up to date")
            is ReleaseDecision.Newer -> decision.release
        }
        when (val plan = UpdatePolicy.plan(trigger, current, System.currentTimeMillis(), custody.lastAutomaticAt())) {
            is UpdatePlan.Hold -> finish(Outcome.Ok(JSONObject().put("state", "held").put("reason", plan.reason)), answering, plan.reason)
            UpdatePlan.Submit -> submit(trigger, release, answering)
        }
    }
    private fun submit(trigger: UpdateTrigger, release: BetaRelease, answering: List<(Outcome<JSONObject>) -> Unit>) {
        if (!activity.packageManager.canRequestPackageInstalls()) {
            if (trigger == UpdateTrigger.Requested) activity.startActivity(Intent(Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES, Uri.parse("package:${activity.packageName}")))
            return finish(Outcome.Err("permission_missing", "Allow ${APP_LABEL} to request package installation in Android settings"), answering)
        }
        record("Downloading verified ${APP_LABEL} ${release.versionName}")
        val inScope = { !closed && (trigger == UpdateTrigger.Requested || active) }
        worker.execute {
            val updater = ApkUpdater(activity)
            val prepared = nativeAttempt { updater.prepare(release.download(origin), origin, "") }
            if (prepared is Outcome.Ok) staged.set(File(prepared.value.getString("path")))
            if (closed) { staged.getAndSet(null)?.delete(); return@execute }
            staged.set(null)
            val result = when (prepared) {
                is Outcome.Err -> prepared
                is Outcome.Ok -> nativeAttempt { updater.install(prepared.value, inScope) }
            }
            if (result is Outcome.Ok && trigger == UpdateTrigger.Automatic) custody.automaticPrompted(System.currentTimeMillis())
            handler.post { if (!closed) finish(result, answering, if (result is Outcome.Ok) "Update ${release.versionName} submitted; confirm Android installation" else null) }
        }
    }
    private fun finish(outcome: Outcome<JSONObject>, answering: List<(Outcome<JSONObject>) -> Unit>, status: String? = null) {
        busy = false
        finishNativeAttempt(
            schedule = {
                if (closed) return@finishNativeAttempt
                if (requests.isNotEmpty()) handler.post { inspect() }
                else if (active) handler.postDelayed(tick, TimeUnit.MINUTES.toMillis(30))
            },
            report = {
                record(status ?: when (outcome) { is Outcome.Err -> "${outcome.code}: ${outcome.message}"; is Outcome.Ok -> outcome.value.toString() })
                for (callback in answering) callback(outcome)
            }
        )
    }
    override fun close() {
        if (closed) return
        closed = true; pause(); staged.getAndSet(null)?.delete(); handler.removeCallbacksAndMessages(null)
        worker.execute { check.close() }
        worker.shutdown()
    }
}
