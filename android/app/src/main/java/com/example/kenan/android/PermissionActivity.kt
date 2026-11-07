package com.example.kenan.android

import android.Manifest
import android.app.Activity
import android.content.Intent
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.provider.Settings

/** Presents a permission request initiated from the phone-settings command; Android owns the decision. */
class PermissionActivity : Activity() {
    private fun first(key: String): Boolean {
        val prefs = getSharedPreferences("phone-settings-requests", MODE_PRIVATE)
        if (prefs.getBoolean(key, false)) return false
        return prefs.edit().putBoolean(key, true).commit()
    }
    override fun onCreate(state: Bundle?) {
        super.onCreate(state)
        if (state != null) return
        val special = intent.getStringExtra("special")
        if (special != null) {
            if (!first("special:$special")) { finish(); return }
            val action = when (special) {
                Manifest.permission.PACKAGE_USAGE_STATS -> Settings.ACTION_USAGE_ACCESS_SETTINGS
                Manifest.permission.SYSTEM_ALERT_WINDOW -> Settings.ACTION_MANAGE_OVERLAY_PERMISSION
                Manifest.permission.WRITE_SETTINGS -> Settings.ACTION_MANAGE_WRITE_SETTINGS
                Manifest.permission.ACCESS_NOTIFICATION_POLICY -> Settings.ACTION_NOTIFICATION_POLICY_ACCESS_SETTINGS
                Manifest.permission.BIND_NOTIFICATION_LISTENER_SERVICE -> Settings.ACTION_NOTIFICATION_LISTENER_SETTINGS
                Manifest.permission.BIND_ACCESSIBILITY_SERVICE -> Settings.ACTION_ACCESSIBILITY_SETTINGS
                else -> { finish(); return }
            }
            val target = Intent(action)
            if (special in setOf(Manifest.permission.SYSTEM_ALERT_WINDOW, Manifest.permission.WRITE_SETTINGS)) target.data = Uri.parse("package:$packageName")
            try { startActivity(target) } finally { finish() }
            return
        }
        if (intent.getBooleanExtra("battery", false)) {
            if (!first("battery")) { finish(); return }
            try { startActivity(Intent(Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS, Uri.parse("package:$packageName"))) }
            finally { finish() }
            return
        }
        val permission = intent.getStringExtra("permission") ?: run { finish(); return }
        if (permission == Manifest.permission.ACCESS_BACKGROUND_LOCATION && Build.VERSION.SDK_INT >= 29) {
            val foreground = checkSelfPermission(Manifest.permission.ACCESS_FINE_LOCATION) == PackageManager.PERMISSION_GRANTED || checkSelfPermission(Manifest.permission.ACCESS_COARSE_LOCATION) == PackageManager.PERMISSION_GRANTED
            if (!foreground) { finish(); return }
            if (!first("permission:$permission")) { finish(); return }
            if (Build.VERSION.SDK_INT >= 30) {
                try { startActivity(Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS, Uri.parse("package:$packageName"))) }
                finally { finish() }
                return
            }
        }
        if (permission != Manifest.permission.ACCESS_BACKGROUND_LOCATION && !first("permission:$permission")) { finish(); return }
        if (permission == Manifest.permission.ACCESS_FINE_LOCATION && Build.VERSION.SDK_INT >= 31) requestPermissions(arrayOf(Manifest.permission.ACCESS_FINE_LOCATION, Manifest.permission.ACCESS_COARSE_LOCATION), 1)
        else requestPermissions(arrayOf(permission), 1)
    }
    override fun onRequestPermissionsResult(requestCode: Int, permissions: Array<out String>, grantResults: IntArray) {
        super.onRequestPermissionsResult(requestCode, permissions, grantResults)
        PhoneLocation.start(this, prompt = true)
        NoticeService.start(this)
        finish()
    }
}
