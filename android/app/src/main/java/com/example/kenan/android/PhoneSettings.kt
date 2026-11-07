package com.example.kenan.android

import android.Manifest
import android.content.Context
import android.content.Intent
import android.app.AppOpsManager
import android.app.NotificationManager
import android.content.pm.PermissionInfo
import android.os.PowerManager
import android.os.Process
import androidx.core.app.NotificationManagerCompat
import android.content.pm.ApplicationInfo
import android.content.pm.PackageManager
import android.os.Build
import android.os.Handler
import android.os.Looper
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
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit

/** Phone settings commands are serialized so our own read-before-write and undo capture cannot interleave. */
object PhoneSettings {
    private class WriteMismatch(val actual: String?, val undo: JSONObject) : Exception("Android stored a different setting value than requested")
    private val work = Executors.newSingleThreadExecutor()
    private val client = OkHttpClient.Builder().connectTimeout(20, TimeUnit.SECONDS).readTimeout(30, TimeUnit.SECONDS).build()

    fun handle(context: Context, command: JSONObject) {
        val app = context.applicationContext
        val id = command.optString("id")
        // Copy the command before the caller can reuse it.
        val input = JSONObject(command.toString())
        if (input.optString("action") in setOf("start", "end", "ui", "tap", "tap_text", "screenshot")) {
            Handler(Looper.getMainLooper()).post { screen(app, input) { reply(app, id, it) } }
        } else {
            work.execute { reply(app, id, runCatching { execute(app, input) }) }
        }
    }

    private fun reply(context: Context, id: String, result: Result<JSONObject>) {
        val body = JSONObject().put("id", id)
        result.fold({ body.put("ok", true).put("value", it) }, { e ->
            val code = when (e) {
                is PhoneRefusal -> e.code
                is WriteMismatch -> "android_write_mismatch"
                is SecurityException -> "android_permission_required"
                is IllegalArgumentException, is org.json.JSONException -> "invalid_argument"
                else -> "phone_settings_error"
            }
            val error = JSONObject().put("code", code).put("message", e.message ?: e.javaClass.simpleName)
            if (e is WriteMismatch) error.put("value", e.actual ?: JSONObject.NULL).put("undo", e.undo)
            body.put("ok", false).put("error", error)
        })
        post(context, body)
    }

    private fun screen(context: Context, input: JSONObject, done: (Result<JSONObject>) -> Unit) {
        try {
            val action = requiredString(input, "action")
            val command = JSONObject(input.toString()).put("sessionId", "phone-settings")
            when (action) {
                "tap" -> command.put("long", false).put("target", JSONObject().put("kind", "point")
                    .put("x", command.getInt("x")).put("y", command.getInt("y")))
                "tap_text" -> {
                    val text = requiredString(command, "text")
                    val index = command.optInt("index", 0)
                    if (index < 0) throw PhoneRefusal("invalid_argument", "index must be nonnegative")
                    val ui = JSONObject(command.toString()).put("action", "ui")
                    PhoneControl.handle(context, ui) { result ->
                        result.fold({ value ->
                            try {
                                val nodes = value.getJSONArray("nodes")
                                val matches = (0 until nodes.length()).map { nodes.getJSONObject(it) }.filter {
                                    it.optString("text").contains(text, ignoreCase = true) || it.optString("desc").contains(text, ignoreCase = true)
                                }
                                val node = matches.getOrNull(index) ?: throw PhoneRefusal("not_found", "No matching visible element at index $index")
                                command.put("action", "tap").put("long", false).put("target", JSONObject().put("kind", "node").put("node", node.getInt("node")))
                                PhoneControl.handle(context, command, done)
                            } catch (e: Exception) { done(Result.failure(e)) }
                        }, { done(Result.failure(it)) })
                    }
                    return
                }
            }
            PhoneControl.handle(context, command, done)
        } catch (e: Exception) { done(Result.failure(e)) }
    }

    private fun post(context: Context, body: JSONObject) {
        val origin = accountOrigin(context)
        val cookies = CookieManager.getInstance().getCookie(origin) ?: return
        val request = Request.Builder().url("$origin/api/ext/phone-settings/results")
            .header("Cookie", cookies).header("x-kenan-client", "native")
            .post(body.toString().toRequestBody("application/json".toMediaType())).build()
        client.newCall(request).enqueue(object : Callback {
            override fun onFailure(call: Call, e: IOException) = Unit
            override fun onResponse(call: Call, response: Response) { response.close() }
        })
    }

    internal fun requiredString(command: JSONObject, name: String): String {
        if (!command.has(name) || command.isNull(name) || command.opt(name) !is String || command.getString(name).isBlank())
            throw PhoneRefusal("invalid_argument", "$name must be a nonempty string")
        return command.getString(name)
    }

    internal fun settingArguments(command: JSONObject): Pair<String, String> {
        val namespace = requiredString(command, "namespace")
        if (namespace !in setOf("system", "secure", "global")) throw PhoneRefusal("invalid_argument", "namespace must be system, secure, or global")
        return namespace to requiredString(command, "key")
    }

    internal fun undoSetting(namespace: String, key: String, value: String?): JSONObject = JSONObject()
        .put("action", "set").put("namespace", namespace).put("key", key).put("value", value ?: JSONObject.NULL)

    private fun execute(context: Context, command: JSONObject): JSONObject = when (val action = requiredString(command, "action")) {
        "status" -> run {
            val info = context.packageManager.getPackageInfo(context.packageName, 0)
            JSONObject().put("model", "${Build.MANUFACTURER} ${Build.MODEL}")
            .put("android", Build.VERSION.RELEASE).put("sdk", Build.VERSION.SDK_INT)
            .put("version", info.versionName)
            .put("first_install_at", info.firstInstallTime).put("last_update_at", info.lastUpdateTime)
            .put("sms_permission", Texts.smsGranted(context))
            .put("texts", Texts.status(context))
            .put("foreground_location", context.checkSelfPermission(Manifest.permission.ACCESS_FINE_LOCATION) == PackageManager.PERMISSION_GRANTED || context.checkSelfPermission(Manifest.permission.ACCESS_COARSE_LOCATION) == PackageManager.PERMISSION_GRANTED)
            .put("fine_location", context.checkSelfPermission(Manifest.permission.ACCESS_FINE_LOCATION) == PackageManager.PERMISSION_GRANTED)
            .put("background_location", Build.VERSION.SDK_INT < 29 || context.checkSelfPermission(Manifest.permission.ACCESS_BACKGROUND_LOCATION) == PackageManager.PERMISSION_GRANTED)
            .put("package", context.packageName)
            .put("write_secure_settings", context.checkSelfPermission(Manifest.permission.WRITE_SECURE_SETTINGS) == PackageManager.PERMISSION_GRANTED)
            .put("write_system_settings", Settings.System.canWrite(context))
            .put("accessibility", PhoneControl.serviceOn())
            .put("usage_access", context.getSystemService(AppOpsManager::class.java).checkOpNoThrow(AppOpsManager.OPSTR_GET_USAGE_STATS, Process.myUid(), context.packageName) == AppOpsManager.MODE_ALLOWED)
            .put("battery_diag", BatteryDiag.snapshot(context))
            .put("updater", JSONObject().put("origin", accountOrigin(context))
                .put("canRequestInstalls", context.packageManager.canRequestPackageInstalls())
                .put("lastCheck", context.getSharedPreferences("kenan-next-device", Context.MODE_PRIVATE).getString("updateCheckStatus", null) ?: JSONObject.NULL)
                .put("installState", context.getSharedPreferences("kenan-next-device", Context.MODE_PRIVATE).getString("autoUpdateState", null) ?: JSONObject.NULL))
            .put("background_connection", NoticeService.connectionNotificationStatus(context))
            .put("delivered_notifications", AgentAlerts.deliveredStatus(context))
            .put("notifications_enabled", context.getSystemService(NotificationManager::class.java).areNotificationsEnabled())
            .put("notification_listener_access", NotificationManagerCompat.getEnabledListenerPackages(context).contains(context.packageName))
        }
        "packages" -> packages(context, command)
        "get", "set" -> setting(context, command, action)
        "grant" -> grant(context, command)
        "appop" -> throw PhoneRefusal("android_privilege_required", "Changing app operations requires privileged Android access")
        "unrestrict" -> unrestrict(context, command)
        "remove" -> remove(context, command)
        "disable" -> throw PhoneRefusal("android_privilege_required", "Silently disabling or removing another package requires device-owner or privileged Android access")
        else -> throw PhoneRefusal("invalid_argument", "Unknown phone settings action: $action")
    }

    private fun ownPackage(context: Context, command: JSONObject): String {
        val packages = command.optJSONArray("packages") ?: throw PhoneRefusal("invalid_argument", "packages must contain exactly one package")
        if (packages.length() != 1 || packages.optString(0).isBlank()) throw PhoneRefusal("invalid_argument", "packages must contain exactly one package")
        val pkg = packages.getString(0)
        if (pkg != context.packageName) throw PhoneRefusal("android_privilege_required", "Changing another app requires privileged Android access")
        return pkg
    }

    @Suppress("DEPRECATION")
    private fun grant(context: Context, command: JSONObject): JSONObject {
        val pkg = ownPackage(context, command)
        val permission = requiredString(command, "permission")
        val special = when (permission) {
            Manifest.permission.PACKAGE_USAGE_STATS -> context.getSystemService(AppOpsManager::class.java).checkOpNoThrow(AppOpsManager.OPSTR_GET_USAGE_STATS, Process.myUid(), pkg) == AppOpsManager.MODE_ALLOWED
            Manifest.permission.SYSTEM_ALERT_WINDOW -> Settings.canDrawOverlays(context)
            Manifest.permission.WRITE_SETTINGS -> Settings.System.canWrite(context)
            Manifest.permission.ACCESS_NOTIFICATION_POLICY -> context.getSystemService(NotificationManager::class.java).isNotificationPolicyAccessGranted
            Manifest.permission.BIND_NOTIFICATION_LISTENER_SERVICE -> NotificationManagerCompat.getEnabledListenerPackages(context).contains(pkg)
            Manifest.permission.BIND_ACCESSIBILITY_SERVICE -> PhoneControl.serviceOn()
            else -> null
        }
        if (special == true) return JSONObject().put("package", pkg).put("permission", permission).put("granted", true).put("changed", false)
        if (special == false) {
            context.startActivity(Intent(context, PermissionActivity::class.java).putExtra("special", permission).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
            throw PhoneRefusal("permission_pending", "Android special-access request was initiated once inside the app; query status to see its decision")
        }
        if (context.checkSelfPermission(permission) == PackageManager.PERMISSION_GRANTED)
            return JSONObject().put("package", pkg).put("permission", permission).put("granted", true).put("changed", false)
        val pm = context.packageManager
        val declared = pm.getPackageInfo(pkg, PackageManager.GET_PERMISSIONS).requestedPermissions?.contains(permission) == true
        val info = try { pm.getPermissionInfo(permission, 0) } catch (_: PackageManager.NameNotFoundException) { throw PhoneRefusal("invalid_argument", "Unknown Android permission") }
        if (!declared || info.protectionLevel and PermissionInfo.PROTECTION_MASK_BASE != PermissionInfo.PROTECTION_DANGEROUS)
            throw PhoneRefusal("android_privilege_required", "Permission is not a declared runtime permission; Android cannot grant it through an app request")
        if (Build.VERSION.SDK_INT >= 29 && permission == Manifest.permission.ACCESS_BACKGROUND_LOCATION &&
            context.checkSelfPermission(Manifest.permission.ACCESS_FINE_LOCATION) != PackageManager.PERMISSION_GRANTED &&
            context.checkSelfPermission(Manifest.permission.ACCESS_COARSE_LOCATION) != PackageManager.PERMISSION_GRANTED)
            throw PhoneRefusal("android_permission_required", "Grant foreground location first, then request background location separately")
        context.startActivity(Intent(context, PermissionActivity::class.java).putExtra("permission", permission).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
        throw PhoneRefusal("permission_pending", "Android permission request was initiated; it requires a foreground user decision and may be suppressed while the app is in the background")
    }

    private fun unrestrict(context: Context, command: JSONObject): JSONObject {
        val pkg = ownPackage(context, command)
        val power = context.getSystemService(PowerManager::class.java)
        if (power.isIgnoringBatteryOptimizations(pkg)) return JSONObject().put("package", pkg).put("battery_optimization_exempt", true).put("changed", false)
        context.startActivity(Intent(context, PermissionActivity::class.java).putExtra("battery", true).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
        throw PhoneRefusal("permission_pending", "Android battery exemption request was initiated; it requires a foreground user decision and may be suppressed while the app is in the background")
    }

    @Suppress("DEPRECATION")
    private fun remove(context: Context, command: JSONObject): JSONObject {
        val packages = command.optJSONArray("packages") ?: throw PhoneRefusal("invalid_argument", "packages must contain exactly one package")
        if (packages.length() != 1) throw PhoneRefusal("invalid_argument", "Uninstall one downloaded app at a time")
        val pkg = packages.getString(0)
        if (pkg == context.packageName) throw PhoneRefusal("protected_package", "Kenan cannot uninstall itself and remove phone access")
        val app = try { context.packageManager.getApplicationInfo(pkg, 0) }
            catch (_: PackageManager.NameNotFoundException) { throw PhoneRefusal("not_found", "Package is not installed") }
        if (app.flags and (ApplicationInfo.FLAG_SYSTEM or ApplicationInfo.FLAG_UPDATED_SYSTEM_APP) != 0)
            throw PhoneRefusal("android_privilege_required", "Removing a system package requires device-owner or privileged Android access")
        context.startActivity(Intent(Intent.ACTION_DELETE, android.net.Uri.parse("package:$pkg")).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
        throw PhoneRefusal("confirmation_required", "Android uninstall confirmation requested for $pkg; this is not a completed uninstall. Confirm in the visible phone session, then check packages")
    }

    @Suppress("DEPRECATION")
    private fun packages(context: Context, command: JSONObject): JSONObject {
        val scope = command.optString("scope", "third-party")
        if (scope !in setOf("third-party", "all", "removed")) throw PhoneRefusal("invalid_argument", "scope must be third-party, all, or removed")
        val pm = context.packageManager
        val flags = if (scope == "removed") PackageManager.MATCH_UNINSTALLED_PACKAGES else 0
        val apps = pm.getInstalledApplications(flags).filter {
            when (scope) {
                "third-party" -> it.flags and ApplicationInfo.FLAG_SYSTEM == 0
                "removed" -> it.flags and ApplicationInfo.FLAG_INSTALLED == 0
                else -> true
            }
        }.sortedBy { it.packageName }
        val out = JSONArray()
        for (app in apps) out.put(JSONObject().put("package", app.packageName).put("enabled", app.enabled)
            .put("system", app.flags and ApplicationInfo.FLAG_SYSTEM != 0)
            .put("installed", app.flags and ApplicationInfo.FLAG_INSTALLED != 0))
        val fullVisibility = Build.VERSION.SDK_INT < 30 || context.checkSelfPermission("android.permission.QUERY_ALL_PACKAGES") == PackageManager.PERMISSION_GRANTED
        return JSONObject().put("scope", scope).put("packages", out).put("complete", fullVisibility)
    }

    private fun setting(context: Context, command: JSONObject, action: String): JSONObject {
        val (namespace, key) = settingArguments(command)
        val resolver = context.contentResolver
        fun read(): String? = when (namespace) {
            "system" -> Settings.System.getString(resolver, key)
            "secure" -> Settings.Secure.getString(resolver, key)
            else -> Settings.Global.getString(resolver, key)
        }
        val previous = read()
        if (action == "get") return JSONObject().put("namespace", namespace).put("key", key).put("value", previous ?: JSONObject.NULL)
        if (!command.has("value")) throw PhoneRefusal("invalid_argument", "value is required; use null to delete")
        val value = if (command.isNull("value")) null else command.opt("value").let {
            if (it !is String) throw PhoneRefusal("invalid_argument", "value must be a string or null")
            it
        }
        val written = when (namespace) {
            "system" -> Settings.System.putString(resolver, key, value)
            "secure" -> Settings.Secure.putString(resolver, key, value)
            else -> Settings.Global.putString(resolver, key, value)
        }
        if (!written) throw PhoneRefusal("android_write_failed", "Android rejected the settings write")
        val undo = undoSetting(namespace, key, previous)
        val actual = read()
        if (actual != value) throw WriteMismatch(actual, undo)
        return JSONObject().put("namespace", namespace).put("key", key).put("value", actual ?: JSONObject.NULL)
            .put("undo", undo)
    }
}
