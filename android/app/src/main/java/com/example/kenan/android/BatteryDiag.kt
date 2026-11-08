package com.example.kenan.android

import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.net.TrafficStats
import android.media.AudioManager
import android.os.BatteryManager
import android.os.Process
import android.os.SystemClock
import org.json.JSONObject

/** Read-only measurements. Battery values describe the whole device, not this app's drain. */
object BatteryDiag {
    private const val UNAVAILABLE = "unavailable"
    private fun traffic(read: () -> Long): Long? = runCatching { read().takeUnless { it == TrafficStats.UNSUPPORTED.toLong() } }.getOrNull()
    private val processStart = linkedMapOf<String, Long?>(
        "elapsedRealtimeMs" to SystemClock.elapsedRealtime(),
        "processCpuMs" to Process.getElapsedCpuTime(),
        "uidRxBytes" to traffic { TrafficStats.getUidRxBytes(Process.myUid()) },
        "uidTxBytes" to traffic { TrafficStats.getUidTxBytes(Process.myUid()) },
        "uidRxPackets" to traffic { TrafficStats.getUidRxPackets(Process.myUid()) },
        "uidTxPackets" to traffic { TrafficStats.getUidTxPackets(Process.myUid()) }
    )
    private val counters = mutableMapOf<String, Long>()
    private var baseline: Map<String, Long?>? = null
    private var baselineCounters: Map<String, Long>? = null

    @Synchronized fun count(name: String) { counters[name] = (counters[name] ?: 0L) + 1L }
    fun increment(name: String) = count(name)

    /** CPU and traffic start at object creation; battery starts at first snapshot. UID traffic can include other processes. */
    @Synchronized fun snapshot(context: Context): JSONObject {
        val battery = runCatching { context.applicationContext.registerReceiver(null, IntentFilter(Intent.ACTION_BATTERY_CHANGED)) }.getOrNull()
        val manager = runCatching { context.getSystemService(Context.BATTERY_SERVICE) as? BatteryManager }.getOrNull()
        fun property(id: Int): Long? = runCatching { manager?.getIntProperty(id)?.takeUnless { it == Int.MIN_VALUE }?.toLong() }.getOrNull()
        val uid = Process.myUid()
        val level = battery?.getIntExtra(BatteryManager.EXTRA_LEVEL, -1)?.takeIf { it >= 0 }
        val scale = battery?.getIntExtra(BatteryManager.EXTRA_SCALE, -1)?.takeIf { it > 0 }
        val status = battery?.getIntExtra(BatteryManager.EXTRA_STATUS, BatteryManager.BATTERY_STATUS_UNKNOWN)
        val values = linkedMapOf<String, Long?>(
            "elapsedRealtimeMs" to SystemClock.elapsedRealtime(),
            "processCpuMs" to Process.getElapsedCpuTime(),
            "chargeMicroAh" to property(BatteryManager.BATTERY_PROPERTY_CHARGE_COUNTER),
            "currentMicroA" to property(BatteryManager.BATTERY_PROPERTY_CURRENT_NOW),
            "levelPercent" to if (level != null && scale != null) level.toLong() * 100 / scale else null,
            "uidRxBytes" to traffic { TrafficStats.getUidRxBytes(uid) },
            "uidTxBytes" to traffic { TrafficStats.getUidTxBytes(uid) },
            "uidRxPackets" to traffic { TrafficStats.getUidRxPackets(uid) },
            "uidTxPackets" to traffic { TrafficStats.getUidTxPackets(uid) }
        )
        val start = baseline ?: (values + processStart).also { baseline = it; baselineCounters = counters.toMap() }
        val nowJson = JSONObject(); val startJson = JSONObject(); val deltaJson = JSONObject()
        for ((key, value) in values) {
            val initial = start[key]
            nowJson.put(key, value ?: UNAVAILABLE)
            startJson.put(key, initial ?: UNAVAILABLE)
            deltaJson.put(key, if (value != null && initial != null) value - initial else UNAVAILABLE)
        }
        val counterJson = JSONObject(); val counterStartJson = JSONObject(); val counterDeltaJson = JSONObject()
        for ((name, value) in counters) {
            val initial = baselineCounters?.get(name) ?: 0L
            counterJson.put(name, value); counterStartJson.put(name, initial); counterDeltaJson.put(name, value - initial)
        }
        val charging: Any = when (status) {
            BatteryManager.BATTERY_STATUS_CHARGING, BatteryManager.BATTERY_STATUS_FULL -> true
            BatteryManager.BATTERY_STATUS_DISCHARGING, BatteryManager.BATTERY_STATUS_NOT_CHARGING -> false
            else -> UNAVAILABLE
        }
        val activeRecordings: Any = runCatching {
            (context.getSystemService(Context.AUDIO_SERVICE) as? AudioManager)?.activeRecordingConfigurations?.size ?: UNAVAILABLE
        }.getOrElse { UNAVAILABLE }
        return JSONObject().put("scope", "Battery measurements are device-wide; UID traffic may include other processes. CPU and traffic start at diagnostics initialization, battery at first snapshot.")
            .put("notificationState", NoticeService.state).put("accessibilityServiceOn", PhoneControl.serviceOn())
            .put("visibleActiveAudioRecordings", activeRecordings)
            .put("audioRecordingScope", "Recordings visible to this app; not a device-wide microphone indicator")
            .put("pid", Process.myPid()).put("uid", uid).put("charging", charging)
            .put("current", nowJson).put("start", startJson).put("delta", deltaJson)
            .put("counters", counterJson).put("counterStart", counterStartJson).put("counterDelta", counterDeltaJson)
            .put("osBatteryAttribution", "unavailable: privileged BATTERY_STATS or DUMP access required")
            .put("wakelocks", "unavailable: privileged BATTERY_STATS or DUMP access required")
    }
}
