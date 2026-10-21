package com.example.kenan.android

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent

/** Reconnects agent notifications after a reboot or an app update; both broadcasts may start the foreground service. */
class DeviceRestartReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        if (intent.action !in setOf(Intent.ACTION_BOOT_COMPLETED, Intent.ACTION_MY_PACKAGE_REPLACED)) return
        NoticeService.start(context)
    }
}
