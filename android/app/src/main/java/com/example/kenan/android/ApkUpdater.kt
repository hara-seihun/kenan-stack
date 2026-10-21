package com.example.kenan.android

import android.app.PendingIntent
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.pm.PackageInstaller
import android.content.pm.PackageManager
import android.os.Build
import okhttp3.OkHttpClient
import okhttp3.Request
import org.json.JSONObject
import java.io.File
import java.security.MessageDigest
import java.util.concurrent.TimeUnit

class ApkUpdater(private val context: Context) {
    companion object { private val installationLock = Any() }
    fun prepare(args: JSONObject, origin: String, cookies: String): Outcome<JSONObject> {
        if (Build.VERSION.SDK_INT < 28) return Outcome.Err("unsupported", "Verified signing-certificate updates require Android 9 or newer")
        val file = try { File.createTempFile("verified-update-", ".apk", context.cacheDir) }
        catch (e: java.io.IOException) { return Outcome.Err("storage_failure", "APK staging file could not be created") }
        return try {
            val size = args.getLong("size"); require(size > 0 && size <= context.cacheDir.usableSpace) { "Insufficient available storage for APK; free cache space and retry" }
            val hash = args.getString("sha256"); require(hash.matches(Regex("[a-f0-9]{64}")))
            val version = args.getLong("versionCode")
            val url = java.net.URI(args.getString("url"))
            val host = Gateway.parse("${url.scheme}://${url.rawAuthority}")
            require(host is Outcome.Ok && host.value.origin == origin && url.rawUserInfo == null && url.rawFragment == null && url.rawQuery == null) { "Update must be served by the exact configured gateway origin" }
            val current = context.packageManager.getPackageInfo(context.packageName, PackageManager.GET_SIGNING_CERTIFICATES)
            require(version > current.longVersionCode) { "Update version must increase" }
            val client = OkHttpClient.Builder().followRedirects(false).readTimeout(60, TimeUnit.SECONDS).build()
            try {
                client.newCall(Request.Builder().url(url.toString()).header("Cookie", cookies).build()).execute().use { response ->
                    require(response.code == 200) { "Update download rejected (${response.code})" }
                    val body = response.body ?: throw IllegalArgumentException("Update has no body")
                    body.byteStream().use { input -> java.io.FileOutputStream(file).use { output ->
                        val chunk = ByteArray(65536); var count = 0L
                        while (true) { val read = input.read(chunk); if (read == -1) break; count += read; require(count <= size); output.write(chunk, 0, read) }
                        require(count == size) { "APK size mismatch" }; output.fd.sync()
                    } }
                }
            } finally { client.dispatcher.executorService.shutdown(); client.connectionPool.evictAll() }
            val digest = MessageDigest.getInstance("SHA-256"); file.inputStream().use { input -> val buffer = ByteArray(65536); while (true) { val read = input.read(buffer); if (read == -1) break; digest.update(buffer, 0, read) } }
            require(digest.digest().joinToString("") { "%02x".format(it) } == hash) { "APK digest mismatch" }
            val archive = context.packageManager.getPackageArchiveInfo(file.path, PackageManager.GET_SIGNING_CERTIFICATES) ?: throw IllegalArgumentException("Invalid APK")
            require(archive.packageName == context.packageName && archive.longVersionCode == version) { "APK package/version mismatch" }
            val own = current.signingInfo!!.apkContentsSigners.map { it.toCharsString() }.toSet()
            val candidate = archive.signingInfo!!.apkContentsSigners.map { it.toCharsString() }.toSet()
            require(own == candidate) { "APK signing identity mismatch" }
            Outcome.Ok(JSONObject().put("path", file.path).put("size", size).put("versionCode", version))
        } catch (e: IllegalArgumentException) { file.delete(); Outcome.Err("invalid_input", e.message ?: "APK verification failed") }
        catch (e: java.io.IOException) { file.delete(); Outcome.Err("platform_failure", e.message ?: "APK download/storage failed") }
        catch (e: Exception) { file.delete(); Outcome.Err("platform_failure", e.message ?: "APK inspection failed") }
    }
    /** Abandons every earlier session of this app before committing one new session, so at most one Android
     * consent screen can exist; a consent screen of an abandoned session would otherwise ignore Update. */
    fun install(verified: JSONObject, canSubmit: () -> Boolean = { true }): Outcome<JSONObject> {
        if (android.os.Looper.myLooper() == android.os.Looper.getMainLooper()) return Outcome.Err("platform_failure", "APK installation must run on a worker")
        return synchronized(installationLock) { boundary {
        val staged = File(verified.getString("path"))
        try {
        require(canSubmit()) { "Update scope changed before Android installation" }
        require(Build.VERSION.SDK_INT < 26 || context.packageManager.canRequestPackageInstalls()) { "Allow ${APP_LABEL} to request package installation in Android settings" }
        val custody = InstallerCustody(context.getSharedPreferences("kenan-next-device", Context.MODE_PRIVATE))
        val installer = context.packageManager.packageInstaller
        check(custody.clear()) { "Earlier installer custody could not be released" }
        for (earlier in installer.mySessions) try { installer.abandonSession(earlier.sessionId) } catch (_: SecurityException) {}
        val params = PackageInstaller.SessionParams(PackageInstaller.SessionParams.MODE_FULL_INSTALL).apply { setAppPackageName(context.packageName); setSize(verified.getLong("size")); if (Build.VERSION.SDK_INT >= 31) setRequireUserAction(PackageInstaller.SessionParams.USER_ACTION_NOT_REQUIRED) }
        val id = installer.createSession(params)
        var entered = false
        try {
            installer.openSession(id).use { session ->
                staged.inputStream().use { input -> session.openWrite("next.apk", 0, verified.getLong("size")).use { output -> input.copyTo(output); session.fsync(output) } }
                require(canSubmit()) { "Update scope changed before Android installation" }
                val intent = Intent(context, UpdateReceiver::class.java).setAction("${context.packageName}.INSTALL_RESULT")
                val pending = PendingIntent.getBroadcast(context, id, intent, PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_MUTABLE)
                check(custody.submitted(id, verified.getLong("versionCode"), System.currentTimeMillis())) { "Installer custody could not be retained" }
                entered = true
                session.commit(pending.intentSender)
            }
        } catch (e: Exception) {
            if (!entered) installer.abandonSession(id)
            throw e
        }
        JSONObject().put("state", "submitted-for-android-consent").put("sessionId", id).put("installed", false)
        } finally { staged.delete() }
    } }
    }
}

/** Android's consent screen is shown only while the app is in the foreground. One that arrives in the
 * background is held and shown when the person next opens the app. */
object UpdateConsent {
    @Volatile var foreground = false
    private var held: Pair<Int, Intent>? = null
    @Synchronized fun offer(context: Context, session: Int, confirmation: Intent): Outcome<Unit> {
        if (!foreground) { held = session to confirmation; return Outcome.Ok(Unit) }
        held = null
        return show(context, confirmation)
    }
    /** Shows a held consent screen if it still belongs to the current session; returns whether one was shown. */
    @Synchronized fun showHeld(context: Context, current: Int?): Boolean {
        val (session, confirmation) = held ?: return false
        held = null
        if (session != current) return false
        return show(context, confirmation) is Outcome.Ok
    }
    private fun show(context: Context, confirmation: Intent): Outcome<Unit> = try {
        // CLEAR_TASK: Android otherwise brings forward an older consent screen left in the installer's task,
        // whose session was abandoned, so its Update button silently does nothing.
        context.startActivity(confirmation.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TASK)); Outcome.Ok(Unit)
    } catch (error: Exception) { Outcome.Err("platform_failure", "Android's update prompt could not open: ${error.javaClass.simpleName}") }
}

class UpdateReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        val status = intent.getIntExtra(PackageInstaller.EXTRA_STATUS, Int.MIN_VALUE)
        val session = intent.getIntExtra(PackageInstaller.EXTRA_SESSION_ID, -1)
        val custody = InstallerCustody(context.getSharedPreferences("kenan-next-device", Context.MODE_PRIVATE))
        val now = System.currentTimeMillis()
        val message = intent.getStringExtra(PackageInstaller.EXTRA_STATUS_MESSAGE) ?: "Android supplied no status"
        when (status) {
            PackageInstaller.STATUS_PENDING_USER_ACTION -> {
                if (!custody.settle(session, "awaiting-android-consent", now, "awaiting-android-consent")) return
                val confirmation = if (Build.VERSION.SDK_INT >= 33) intent.getParcelableExtra(Intent.EXTRA_INTENT, Intent::class.java) else @Suppress("DEPRECATION") intent.getParcelableExtra<Intent>(Intent.EXTRA_INTENT)
                val shown = if (confirmation == null) Outcome.Err("platform_failure", "Android supplied no consent activity") else UpdateConsent.offer(context, session, confirmation)
                if (shown is Outcome.Err) custody.settle(session, "failed", now, "failed:${shown.message}")
            }
            PackageInstaller.STATUS_SUCCESS -> custody.settle(session, "installed", now, "installed")
            PackageInstaller.STATUS_FAILURE_ABORTED -> custody.settle(session, "declined", now, "declined")
            else -> custody.settle(session, "failed", now, "failed:$message")
        }
    }
}
