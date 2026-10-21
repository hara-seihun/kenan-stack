package com.example.kenan.android

import android.content.SharedPreferences
import java.util.concurrent.TimeUnit

/** What the app last handed to Android's package installer, as persisted in the device preferences. */
sealed interface InstallerRecord {
    data object Clear : InstallerRecord
    /** Committed; Android's consent screen is pending or open. */
    data class Submitted(val session: Int, val version: Long, val at: Long) : InstallerRecord
    /** The person tapped Cancel (or backed out of) Android's consent screen. */
    data class Declined(val session: Int, val version: Long, val at: Long) : InstallerRecord
    data class Failed(val session: Int, val version: Long, val at: Long, val message: String) : InstallerRecord
    data class Installed(val session: Int, val version: Long) : InstallerRecord
}

enum class UpdateTrigger { Automatic, Requested }

sealed interface UpdatePlan {
    data object Submit : UpdatePlan
    data class Hold(val reason: String) : UpdatePlan
}

object UpdatePolicy {
    /** An unanswered consent screen is left alone this long before the record counts as unanswered. */
    val CONSENT_OPEN_MS = TimeUnit.MINUTES.toMillis(10)
    /** Cancel on Android's prompt: no automatic prompt for a day. The in-app banner still offers the update. */
    val DECLINE_SNOOZE_MS = TimeUnit.HOURS.toMillis(24)
    /** Releases are batched on the phone: at most one automatic prompt per this interval, whatever shipped since. */
    val AUTOMATIC_INTERVAL_MS = TimeUnit.HOURS.toMillis(20)
    /** A real installation failure is retried automatically after this delay. */
    val FAILURE_RETRY_MS = TimeUnit.MINUTES.toMillis(30)

    /** Automatic prompts only ever happen while the app is in the foreground; that is the caller's precondition. */
    fun plan(trigger: UpdateTrigger, record: InstallerRecord, now: Long, lastAutomaticAt: Long?): UpdatePlan = when (trigger) {
        UpdateTrigger.Requested -> UpdatePlan.Submit
        UpdateTrigger.Automatic -> when (record) {
            is InstallerRecord.Submitted ->
                if (within(now, record.at, CONSENT_OPEN_MS)) UpdatePlan.Hold("Android's update prompt is open")
                else interval(now, lastAutomaticAt)
            is InstallerRecord.Declined ->
                if (within(now, record.at, DECLINE_SNOOZE_MS)) UpdatePlan.Hold("Update declined; ${APP_LABEL} asks again in a day, or tap Install update")
                else UpdatePlan.Submit
            is InstallerRecord.Failed ->
                if (within(now, record.at, FAILURE_RETRY_MS)) UpdatePlan.Hold("Update failed (${record.message}); retrying later")
                else UpdatePlan.Submit
            InstallerRecord.Clear, is InstallerRecord.Installed -> interval(now, lastAutomaticAt)
        }
    }
    /** A time in the future (the phone's clock moved back) counts as elapsed rather than holding indefinitely. */
    private fun within(now: Long, at: Long, span: Long) = now - at in 0 until span
    private fun interval(now: Long, lastAutomaticAt: Long?): UpdatePlan =
        if (lastAutomaticAt != null && within(now, lastAutomaticAt, AUTOMATIC_INTERVAL_MS)) UpdatePlan.Hold("Update available; ${APP_LABEL} prompts at most once a day, or tap Install update")
        else UpdatePlan.Submit
}

/** The one reader and writer of installer custody in the device preferences. */
class InstallerCustody(private val prefs: SharedPreferences) {
    fun read(): Outcome<InstallerRecord> {
        if (!prefs.contains("autoUpdateSession")) return Outcome.Ok(InstallerRecord.Clear)
        val session = prefs.getInt("autoUpdateSession", -1)
        val version = prefs.getLong("autoUpdateVersion", -1)
        val started = prefs.getLong("autoUpdateStartedAt", -1)
        if (session < 0 || version < 1 || started < 0) return Outcome.Err("invalid_input", "Installer record is incomplete")
        val settled = if (prefs.contains("autoUpdateSettledAt")) prefs.getLong("autoUpdateSettledAt", started) else started
        return when (val state = prefs.getString("autoUpdateState", null)) {
            "dispatch-entered", "awaiting-android-consent" -> Outcome.Ok(InstallerRecord.Submitted(session, version, started))
            "declined" -> Outcome.Ok(InstallerRecord.Declined(session, version, settled))
            "failed" -> Outcome.Ok(InstallerRecord.Failed(session, version, settled, prefs.getString("updateStatus", null)?.removePrefix("failed:") ?: "Android supplied no status"))
            "installed" -> Outcome.Ok(InstallerRecord.Installed(session, version))
            else -> Outcome.Err("invalid_input", "Unknown installer state: $state")
        }
    }
    fun submitted(session: Int, version: Long, now: Long): Boolean = prefs.edit().putInt("autoUpdateSession", session).putLong("autoUpdateVersion", version)
        .putString("autoUpdateState", "dispatch-entered").putLong("autoUpdateStartedAt", now).remove("autoUpdateSettledAt").commit()
    /** Records Android's verdict for [session]; a verdict for any other session is stale and ignored. */
    fun settle(session: Int, state: String, now: Long, status: String): Boolean {
        if (session < 0 || session != prefs.getInt("autoUpdateSession", -1)) return false
        return prefs.edit().putString("autoUpdateState", state).putLong("autoUpdateSettledAt", now).putString("updateStatus", status).commit()
    }
    fun clear(): Boolean = prefs.edit().remove("autoUpdateSession").remove("autoUpdateVersion").remove("autoUpdateState")
        .remove("autoUpdateStartedAt").remove("autoUpdateSettledAt").commit()
    fun lastAutomaticAt(): Long? = if (prefs.contains("autoUpdatePromptedAt")) prefs.getLong("autoUpdatePromptedAt", 0) else null
    fun automaticPrompted(now: Long): Boolean = prefs.edit().putLong("autoUpdatePromptedAt", now).commit()
}
