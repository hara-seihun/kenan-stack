package com.example.kenan.android

import android.content.Context
import android.os.Build
import android.webkit.CookieManager
import androidx.test.platform.app.InstrumentationRegistry
import org.junit.Assert.*
import org.junit.Before
import org.junit.After
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit

abstract class OwnedDeviceTest {
    private val instrumentation get() = InstrumentationRegistry.getInstrumentation()
    private val context get() = instrumentation.targetContext
    private data class RetainedDeviceState(val preferences: Map<String, *>, val cookiePairs: Set<String>, val sessionCookie: String?)
    private var retainedDeviceState: RetainedDeviceState? = null
    private fun cookiePairs(header: String?): Set<String> = header?.split(';')?.map { it.trim() }?.filter { it.isNotEmpty() }?.toSet() ?: emptySet()

    @Before fun preserveRetainedDeviceState() {
        check(Build.HARDWARE in setOf("ranchu", "goldfish")) { "Disposable emulator required" }
        val preferences=context.getSharedPreferences("kenan-next-device",Context.MODE_PRIVATE).all.mapValues { (_,value) -> if(value is Set<*>) value.toSet() else value }
        var pairs: Set<String> = emptySet()
        instrumentation.runOnMainSync { val manager=CookieManager.getInstance();manager.flush();pairs=cookiePairs(manager.getCookie(BETA_ORIGIN)) }
        val sessions=pairs.filter { it.startsWith("kenan_session=") }
        check(sessions.size<=1) { "Fixture cannot replace ambiguous origin sessions" }
        val session=sessions.singleOrNull()?.let { pair ->
            // CookieManager's header omits expiry/security attributes. Read metadata under our UID,
            // rather than replacing a retained persistent cookie with a new session-only cookie.
            val host=android.net.Uri.parse(BETA_ORIGIN).host ?: error("Fixture origin host is unset")
            val database=java.io.File(context.applicationInfo.dataDir,"app_webview/Default/Cookies")
            check(database.isFile) { "Retained cookie metadata unavailable; no fixture mutation admitted" }
            android.database.sqlite.SQLiteDatabase.openDatabase(database.path,null,android.database.sqlite.SQLiteDatabase.OPEN_READONLY).use { db ->
                db.rawQuery("SELECT expires_utc,is_secure,is_httponly,samesite,has_expires FROM cookies WHERE name=? AND host_key=? AND path='/'",arrayOf("kenan_session",host)).use { rows ->
                    check(rows.count==1 && rows.moveToFirst()) { "Retained cookie metadata is ambiguous; no fixture mutation admitted" }
                    buildString {
                        append(pair);append("; Path=/")
                        if(rows.getInt(1)!=0)append("; Secure")
                        if(rows.getInt(2)!=0)append("; HttpOnly")
                        when(rows.getInt(3)) { -1 -> Unit;0 -> append("; SameSite=None");1 -> append("; SameSite=Lax");2 -> append("; SameSite=Strict");else -> error("Unknown retained cookie same-site policy") }
                        if(rows.getInt(4)!=0) {
                            val formatter=java.text.SimpleDateFormat("EEE, dd MMM yyyy HH:mm:ss 'GMT'",java.util.Locale.US)
                            formatter.timeZone=java.util.TimeZone.getTimeZone("GMT")
                            append("; Expires=");append(formatter.format(java.util.Date(rows.getLong(0)/1000L-11644473600000L)))
                        }
                    }
                }
            }
        }
        retainedDeviceState=RetainedDeviceState(preferences,pairs,session)
    }
    @After fun restoreRetainedDeviceState() {
        val retained=retainedDeviceState ?: return
        val preferences=context.getSharedPreferences("kenan-next-device",Context.MODE_PRIVATE)
        val edit=preferences.edit().clear()
        for((key,value) in retained.preferences) when(value) {
            is String -> edit.putString(key,value);is Boolean -> edit.putBoolean(key,value);is Int -> edit.putInt(key,value)
            is Long -> edit.putLong(key,value);is Float -> edit.putFloat(key,value)
            is Set<*> -> edit.putStringSet(key,value.map { check(it is String) { "Invalid retained string-set" };it }.toSet())
            else -> error("Unknown retained preference type")
        }
        check(edit.commit()) { "Retained device preferences could not be restored" }
        val done=CountDownLatch(1)
        instrumentation.runOnMainSync {
            val manager=CookieManager.getInstance()
            manager.setCookie(BETA_ORIGIN,"kenan_session=; Max-Age=0; Path=/") {
                val session=retained.sessionCookie
                if(session==null) { manager.flush();done.countDown() }
                else manager.setCookie(BETA_ORIGIN,session) { manager.flush();done.countDown() }
            }
        }
        assertTrue("Retained origin cookie restoration completed",done.await(5,TimeUnit.SECONDS))
        var restored: Set<String> = emptySet()
        instrumentation.runOnMainSync { restored=cookiePairs(CookieManager.getInstance().getCookie(BETA_ORIGIN)) }
        assertTrue("Origin cookie values preserved",restored==retained.cookiePairs)
        assertTrue("Whole device preferences preserved",preferences.all==retained.preferences)
        retainedDeviceState=null
    }

}
