package com.example.kenan.android

import android.content.Intent
import android.webkit.CookieManager
import android.webkit.WebView
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import androidx.test.runner.lifecycle.ActivityLifecycleMonitorRegistry
import androidx.test.runner.lifecycle.Stage
import androidx.test.uiautomator.UiDevice
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test
import org.junit.runner.RunWith
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit

@RunWith(AndroidJUnit4::class)
class WarmPagesTest : OwnedDeviceTest() {
    private val instrumentation get() = InstrumentationRegistry.getInstrumentation()
    private val context get() = instrumentation.targetContext
    private fun view(activity: MainActivity) = MainActivity::class.java.getDeclaredField("web").apply { isAccessible = true }.get(activity) as WebView
    private fun js(view: WebView, code: String) = readOwnedJavascript(view, code)
    private fun await(description: String, condition: () -> Boolean) {
        val until = System.currentTimeMillis() + 5000
        while (System.currentTimeMillis() < until) { if (condition()) return; Thread.sleep(25) }
        assertTrue(description, condition())
    }
    private fun intent() = Intent(context, BubbleActivity::class.java).setAction("open-notice")
        .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_NEW_DOCUMENT or Intent.FLAG_ACTIVITY_MULTIPLE_TASK)
        .setData(android.net.Uri.parse("kenan-next://conversation/warm-fixture"))
        .putExtra("accountId", "warm-owner").putExtra("noticeDomainId", "warm-domain").putExtra("conversationId", "warm-chat")

    @Test fun openingAndRecreatingBubbleRetainsDocumentDraftScrollAndRebindsNativeBridge() {
        val device = UiDevice.getInstance(instrumentation); device.wakeUp(); device.executeShellCommand("wm dismiss-keyguard")
        DeviceStore(context).use { store ->
            store.bind("warm-owner", "warm-epoch", "warm-domain")
            store.prefs.edit().putBoolean("connectionEnabled", false).putBoolean("phoneEnabled", false).putBoolean("noticePermissionRequested", true).commit()
        }
        instrumentation.runOnMainSync {
            WarmPages.clear()
            CookieManager.getInstance().setCookie(BETA_ORIGIN, "kenan_session=warm-fixture; Path=/")
        }
        var activity = instrumentation.startActivitySync(intent()) as BubbleActivity
        try {
            val original = view(activity)
            lateinit var loaded: CountDownLatch
            instrumentation.runOnMainSync {
                loaded = loadOwnedConversationPage(original, BETA_ORIGIN + "/?accountId=warm-owner&noticeDomainId=warm-domain&conversationId=warm-chat",
                    """<html><meta name='viewport' content='width=device-width,initial-scale=1'><body style='margin:0;background:black;color:white'><p>Retained conversation</p><textarea id='draft'>Keep my draft</textarea><div style='height:5000px'>Messages</div><script>window.documentIdentity='original';window.bridgeReplies={};window.KenanNext.onmessage=function(e){var x=JSON.parse(e.data);window.bridgeReplies[x.id]=x.result;};</script></body></html>""")
            }
            assertTrue("Owned warm document navigation completed", loaded.await(5, TimeUnit.SECONDS))
            await("Fixture document loaded") { js(original, "window.documentIdentity") == "\"original\"" }
            await("Owned fixture accepted initial selection and scroll") {
                js(original, "(()=>{const d=document.getElementById('draft');if(window.documentIdentity!=='original'||!d)return false;d.setSelectionRange(3,7);window.scrollTo(0,400);return d.selectionStart===3&&d.selectionEnd===7;})()") == "true"
            }
            val scroll = js(original, "window.scrollY")
            instrumentation.runOnMainSync {
                assertTrue("Fixture must have a trusted document URL: ${original.url}", original.url?.startsWith(BETA_ORIGIN) == true)
                assertNotNull(CookieManager.getInstance().getCookie(BETA_ORIGIN))
            }
            instrumentation.runOnMainSync { NativeThreadPresence.record(activity, ThreadPresence("warm-owner", "warm-domain", "warm-chat", true)) }
            repeat(10) {
                instrumentation.runOnMainSync { MainActivity::class.java.getDeclaredMethod("onNewIntent", Intent::class.java).apply { isAccessible = true }.invoke(activity, intent()) }
                assertEquals("\"original\"", js(original, "window.documentIdentity"))
            }
            device.waitForIdle()
            val samples = mutableListOf<Long>()
            repeat(3) {
                val previous = activity
                val start = android.os.SystemClock.elapsedRealtime()
                instrumentation.runOnMainSync { previous.recreate() }
                await("Replacement bubble is resumed") {
                    var next: BubbleActivity? = null
                    instrumentation.runOnMainSync { next = ActivityLifecycleMonitorRegistry.getInstance().getActivitiesInStage(Stage.RESUMED).filterIsInstance<BubbleActivity>().firstOrNull { it !== previous } }
                    if (next != null) activity = next!!
                    next != null
                }
                samples += android.os.SystemClock.elapsedRealtime() - start
                assertSame("Recreation must reuse the rendered document", original, view(activity))
                assertEquals("\"original\"", js(original, "window.documentIdentity"))
                assertEquals("\"Keep my draft\"", js(original, "document.getElementById('draft').value"))
                assertEquals("3", js(original, "document.getElementById('draft').selectionStart"))
                assertEquals("7", js(original, "document.getElementById('draft').selectionEnd"))
                await("Retained page restores its scroll after reattachment layout; expected=$scroll") { kotlin.math.abs(js(original, "window.scrollY").toDouble() - scroll.toDouble()) < 1.0 }
                val id = "rebound-$it"
                js(original, "window.KenanNext.postMessage(JSON.stringify({id:'$id',name:'threadPresence',args:{accountId:'warm-owner',domainId:'warm-domain',conversationId:'warm-chat',visible:true}}));true")
                await("Native bridge is bound to the new Activity") { js(original, "window.bridgeReplies['$id']?.ok") == "true" }
                instrumentation.runOnMainSync {
                    assertSame(activity, (original.context as android.content.MutableContextWrapper).baseContext)
                    assertEquals("warm-chat", NativeThreadPresence.current(activity)?.conversationId)
                }
            }
            // Destroying the task (rather than configuration recreation) uses the same retained page.
            instrumentation.runOnMainSync { activity.finish() }; await("Prior task was destroyed") { activity.isDestroyed }
            activity = instrumentation.startActivitySync(intent()) as BubbleActivity
            assertSame(original, view(activity))
            assertEquals("\"Keep my draft\"", js(original, "document.getElementById('draft').value"))
            java.io.File(context.getExternalFilesDir(null), "warm-bubble-timing.json").writeText(JSONObject()
                .put("reopenIntentsWithoutReload", 10).put("recreationsWithoutReload", 3).put("taskRelaunchWithoutReload", true)
                .put("recreationElapsedMs", org.json.JSONArray(samples)).toString())
            // A different login must never acquire the previous rendered page.
            instrumentation.runOnMainSync { activity.finish() }; await("Prior task was destroyed") { activity.isDestroyed }
            instrumentation.runOnMainSync { CookieManager.getInstance().setCookie(BETA_ORIGIN, "kenan_session=different-fixture; Path=/") }
            activity = instrumentation.startActivitySync(intent()) as BubbleActivity
            assertNotSame(original, view(activity))
        } finally {
            instrumentation.runOnMainSync {
                activity.finish(); WarmPages.clear()
                CookieManager.getInstance().setCookie(BETA_ORIGIN, "kenan_session=; Max-Age=0; Path=/")
            }
        }
    }

    @Test fun closingAndReopeningAppRetainsMainDocumentAndCatchesUp() {
        val device = UiDevice.getInstance(instrumentation); device.wakeUp(); device.executeShellCommand("wm dismiss-keyguard")
        DeviceStore(context).use { store ->
            store.bind("warm-owner", "warm-epoch", "warm-domain")
            store.prefs.edit().putBoolean("connectionEnabled", false).putBoolean("phoneEnabled", false).putBoolean("noticePermissionRequested", true).commit()
        }
        instrumentation.runOnMainSync {
            WarmPages.clear()
            CookieManager.getInstance().setCookie(BETA_ORIGIN, "kenan_session=warm-main; Path=/")
        }
        val launch = { Intent(context, MainActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK) }
        var activity = instrumentation.startActivitySync(launch()) as MainActivity
        try {
            val original = view(activity)
            lateinit var loaded: CountDownLatch
            instrumentation.runOnMainSync {
                loaded = loadOwnedConversationPage(original, "$BETA_ORIGIN/",
                    """<html><meta name='viewport' content='width=device-width,initial-scale=1'><body style='margin:0;background:black;color:white'><p>Long thread</p><textarea id='draft'>Unsent words</textarea><div style='height:5000px'>Messages</div><script>window.documentIdentity='main';window.visibleAgain=0;document.addEventListener('visibilitychange',function(){if(document.visibilityState==='visible')window.visibleAgain++;});</script></body></html>""")
            }
            assertTrue("Main fixture navigation completed before JavaScript inspection", loaded.await(5, TimeUnit.SECONDS))
            await("Main fixture loaded") { js(original, "window.documentIdentity") == "\"main\"" }
            device.waitForIdle()
            js(original, "window.scrollTo(0,900);true")
            val scroll = js(original, "window.scrollY")
            device.waitForIdle()
            val samples = mutableListOf<Long>()
            repeat(3) {
                assertSame("Startup recovery must not replace a successfully loaded owned document", original, view(activity))
                val before = js(original, "window.visibleAgain").toInt()
                // Back on the root task finishes the Activity; the process and its rendered page remain.
                instrumentation.runOnMainSync { activity.finish() }; await("App closed") { activity.isDestroyed }
                val start = android.os.SystemClock.elapsedRealtime()
                activity = instrumentation.startActivitySync(launch()) as MainActivity
                device.waitForIdle()
                samples += android.os.SystemClock.elapsedRealtime() - start
                assertSame("Reopening must reuse the rendered document", original, view(activity))
                assertEquals("\"Unsent words\"", js(original, "document.getElementById('draft').value"))
                await("Retained page restores its scroll after reattachment layout; expected=$scroll") { kotlin.math.abs(js(original, "window.scrollY").toDouble() - scroll.toDouble()) < 1.0 }
                // The page learns it is visible again, which is what starts its catch-up reads.
                await("Retained document observes foreground") { js(original, "window.visibleAgain").toInt() > before }
                instrumentation.runOnMainSync { assertSame(activity, (original.context as android.content.MutableContextWrapper).baseContext) }
            }
            java.io.File(context.getExternalFilesDir(null), "warm-main-timing.json").writeText(JSONObject()
                .put("reopensWithoutReload", 3).put("reopenElapsedMs", org.json.JSONArray(samples)).toString())
            instrumentation.runOnMainSync { activity.finish() }; await("App closed") { activity.isDestroyed }
            instrumentation.runOnMainSync { CookieManager.getInstance().setCookie(BETA_ORIGIN, "kenan_session=other-main; Path=/") }
            activity = instrumentation.startActivitySync(launch()) as MainActivity
            assertNotSame("A different login must never acquire the previous page", original, view(activity))
        } finally {
            instrumentation.runOnMainSync {
                activity.finish(); WarmPages.clear()
                CookieManager.getInstance().setCookie(BETA_ORIGIN, "kenan_session=; Max-Age=0; Path=/")
            }
        }
    }
}
