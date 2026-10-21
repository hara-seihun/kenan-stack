package com.example.kenan.android

import android.content.Intent
import android.net.Uri
import android.os.Build
import android.view.View
import android.webkit.WebResourceError
import android.webkit.WebResourceRequest
import android.webkit.WebView
import android.webkit.CookieManager
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import org.junit.Assert.*
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit

@RunWith(AndroidJUnit4::class)
class StartupRecoveryTest : OwnedDeviceTest() {
    private val instrument get() = InstrumentationRegistry.getInstrumentation()
    private val context get() = instrument.targetContext
    private fun view(a: MainActivity) = MainActivity::class.java.getDeclaredField("web").apply { isAccessible = true }.get(a) as? WebView
    private fun surface(a: MainActivity) = MainActivity::class.java.getDeclaredField("startup").apply { isAccessible = true }.get(a) as GatewayStartup
    private fun await(message: String, timeout: Long = 6000, condition: () -> Boolean) {
        val end = System.currentTimeMillis() + timeout
        while (System.currentTimeMillis() < end) { var result = false; instrument.runOnMainSync { result = condition() }; if (result) return; Thread.sleep(50) }
        fail(message)
    }
    private fun fixture(v: WebView, html: String = "<body style='background:black;color:white'>Conversation ready</body>") = loadOwnedConversationPage(v, "$BETA_ORIGIN/", html)
    private fun panel(a: MainActivity) = surface(a).getChildAt(1) as android.view.ViewGroup
    @Before fun ownedEmulator() {
        check(Build.HARDWARE in setOf("ranchu", "goldfish"))
        check(InstrumentationRegistry.getArguments().getString("ownedFixture") == "kenan-beta")
        DeviceStore(context).use { it.prefs.edit().putBoolean("connectionEnabled", false).putBoolean("phoneEnabled", false).putBoolean("noticePermissionRequested", true).commit() }
    }
    @Test fun ordinaryStartupAndNavigationDoNotAddANativeLoadingScreen() {
        instrument.runOnMainSync {
            val web = WebView(context)
            val startup = GatewayStartup(web) {}
            try {
                val panel = startup.getChildAt(1) as android.view.ViewGroup
                assertEquals("Retained pages start visible", View.GONE, panel.visibility)
                startup.loading()
                assertEquals("Cold document owns its first frame", View.GONE, panel.visibility)
                startup.ready()
                startup.loading()
                assertEquals("Navigation must not flash another opening screen", View.GONE, panel.visibility)
                startup.unreachable({})
                assertEquals("Failed HTTP content stays masked", View.VISIBLE, panel.visibility)
                assertEquals("Short retry has no extra loading title", "", (panel.getChildAt(0) as android.widget.TextView).text.toString())
                assertEquals("Short retry has no error action", View.GONE, panel.getChildAt(1).visibility)
                startup.ready()
                assertEquals("Recovery reveals the document", View.GONE, panel.visibility)
            } finally { startup.close(); web.destroy() }
        }
    }
    @Test fun failedMainDocumentRetriesQuietlyUntilANewLoadSucceeds() {
        for (dropMs in listOf(100L, 1000L, 3000L)) {
            val a = instrument.startActivitySync(Intent(context, MainActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)) as MainActivity
            val failing = java.util.concurrent.atomic.AtomicBoolean(true)
            val responses = java.util.concurrent.atomic.AtomicInteger(0)
            val failures = java.util.concurrent.atomic.AtomicInteger(0)
            try {
                val original = view(a)!!
                lateinit var completed: CountDownLatch
                instrument.runOnMainSync {
                    original.stopLoading()
                    completed = loadOwnedConversationPage(original, "$BETA_ORIGIN/", "<body>Owned edge response</body>", status = {
                        responses.incrementAndGet(); if (failing.get()) 503 else 200
                    }, onHttpError = { failures.incrementAndGet() })
                    val retired = object : WebResourceRequest {
                        override fun getUrl() = Uri.parse("$BETA_ORIGIN/?ownedFixture=retired")
                        override fun isForMainFrame() = true
                        override fun isRedirect() = false
                        override fun hasGesture() = false
                        override fun getMethod() = "GET"
                        override fun getRequestHeaders() = emptyMap<String, String>()
                    }
                    original.webViewClient.onReceivedHttpError(original, retired,
                        android.webkit.WebResourceResponse("text/html", "UTF-8", 503, "Unavailable", emptyMap(), "retired failure".byteInputStream()))
                    assertEquals("A retired navigation cannot satisfy the fixture failure wait", 0, failures.get())
                }
                await("Native HTTP503 callback must arrive") { failures.get() > 0 }
                val until = android.os.SystemClock.elapsedRealtime() + dropMs
                while (android.os.SystemClock.elapsedRealtime() < until) {
                    instrument.runOnMainSync {
                        assertEquals("Error HTML must not be accepted as ready", View.VISIBLE, panel(a).visibility)
                        assertEquals("Short outage must not offer an error action", View.GONE, panel(a).getChildAt(1).visibility)
                    }
                    Thread.sleep(25)
                }
                assertEquals("Failed HTML cannot complete the owned app navigation", 1L, completed.count)
                assertNotEquals("The edge error response must not announce an app boot", "true",
                    readOwnedJavascript(original, "document.documentElement.dataset.appStarted === 'true'"))
                failing.set(false)
                assertTrue("The successful retry completes the owned app navigation", completed.await(6, TimeUnit.SECONDS))
                await("Quiet retry must load a successful document", 6000) { panel(a).visibility == View.GONE && original.progress == 100 }
                assertSame("Transport retry must preserve the WebView", original, view(a))
                assertTrue("Recovery must actually retry HTTP", responses.get() >= 2)
                assertEquals("\"Owned edge response\"", js(original, "document.body.innerText"))
            } finally { instrument.runOnMainSync { a.finish() } }
        }
    }
    @Test fun aNewDocumentRetiresEarlierNavigationFailuresAndItsLateCallbacks() {
        val a = instrument.startActivitySync(Intent(context, MainActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)) as MainActivity
        val retries = java.util.concurrent.atomic.AtomicInteger(0)
        val retired = "http://127.0.0.1:1/owned-retired-navigation"
        try {
            val original = view(a)!!
            lateinit var loaded: CountDownLatch
            lateinit var retiredRequest: WebResourceRequest
            lateinit var retiredFailure: WebResourceError
            val failed = CountDownLatch(1)
            lateinit var client: android.webkit.WebViewClient
            instrument.runOnMainSync {
                original.stopLoading(); client = original.webViewClient
                original.webViewClient = object : android.webkit.WebViewClient() {
                    override fun onReceivedError(v: WebView, request: WebResourceRequest, error: WebResourceError) {
                        client.onReceivedError(v, request, error)
                        if (request.isForMainFrame && request.url.toString() == retired) {
                            retiredRequest = request; retiredFailure = error; failed.countDown()
                        }
                    }
                }
                original.loadUrl(retired)
            }
            assertTrue("Actual retired navigation failed", failed.await(5, TimeUnit.SECONDS))
            instrument.runOnMainSync {
                original.webViewClient = client
                surface(a).unreachable({ retries.incrementAndGet() }, document = retired)
                loaded = fixture(original, "<body>New conversation<script>window.documentIncarnation=String(Math.random());</script></body>")
            }
            assertTrue("New owned navigation completed", loaded.await(5, TimeUnit.SECONDS))
            await("New document supersedes the earlier retry owner") { panel(a).visibility == View.GONE }
            val incarnation = readOwnedJavascript(original, "window.documentIncarnation")
            assertNotEquals("null", incarnation)
            instrument.runOnMainSync {
                original.webViewClient.onReceivedError(original, retiredRequest, retiredFailure)
                original.webViewClient.onReceivedHttpError(original, retiredRequest,
                    android.webkit.WebResourceResponse("text/html", "UTF-8", 503, "Unavailable", emptyMap(), "old failure".byteInputStream()))
            }
            Thread.sleep(1200)
            assertEquals("Retired retry never fires", 0, retries.get())
            assertSame(original, view(a))
            assertEquals("Late errors never reload the new document", incarnation, readOwnedJavascript(original, "window.documentIncarnation"))
            instrument.runOnMainSync {
                assertEquals(View.GONE, panel(a).visibility)
                // Same-URL callbacks have no platform navigation ID. An actual
                // trusted app handshake is the positive readiness evidence.
                surface(a).unreachable({ retries.incrementAndGet() }, document = original.url)
            }
            readOwnedJavascript(original, "delete document.documentElement.dataset.appStarted;window.KenanNext.onmessage=function(e){window.ownedReadyReply=JSON.parse(e.data).id;};window.KenanNext.postMessage(JSON.stringify({id:'owned-not-ready',name:'refreshSession',args:{}}));true")
            val replyDeadline = System.currentTimeMillis() + 5000
            while (System.currentTimeMillis() < replyDeadline && readOwnedJavascript(original, "window.ownedReadyReply") != "\"owned-not-ready\"") Thread.sleep(10)
            instrument.runOnMainSync { assertEquals("A bridge message without the current app-start marker cannot retire retry", View.VISIBLE, panel(a).visibility) }
            readOwnedJavascript(original, "document.documentElement.dataset.appStarted='true';window.KenanNext.postMessage(JSON.stringify({id:'owned-ready',name:'refreshSession',args:{}}));true")
            await("Interactive app handshake retires same-URL retry") { panel(a).visibility == View.GONE }
            Thread.sleep(700)
            assertEquals(0, retries.get())
            assertEquals(incarnation, readOwnedJavascript(original, "window.documentIncarnation"))
        } finally { instrument.runOnMainSync { a.finish() } }
    }
    @Test fun sustainedHttpOutageOffersRetryAndStillRecoversAutomatically() {
        val a = instrument.startActivitySync(Intent(context, MainActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)) as MainActivity
        val failing = java.util.concurrent.atomic.AtomicBoolean(true)
        val responses = java.util.concurrent.atomic.AtomicInteger(0)
        try {
            instrument.runOnMainSync {
                view(a)!!.stopLoading()
                loadOwnedConversationPage(view(a)!!, "$BETA_ORIGIN/", "<body>Owned edge response</body>", status = {
                    responses.incrementAndGet(); if (failing.get()) 503 else 200
                })
            }
            await("Sustained failures must offer manual recovery", 11500) {
                panel(a).visibility == View.VISIBLE && panel(a).getChildAt(1).visibility == View.VISIBLE
            }
            assertTrue("Notice requires failed retries", responses.get() >= 2)
            failing.set(false)
            await("Sustained outage must recover without a tap", 6000) { panel(a).visibility == View.GONE }
            assertEquals("\"Owned edge response\"", js(view(a)!!, "document.body.innerText"))
        } finally { instrument.runOnMainSync { a.finish() } }
    }
    @Test fun unreachableDocumentOffersNativeRetryAndRecovers() {
        val a = instrument.startActivitySync(Intent(context, MainActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)) as MainActivity
        try {
            instrument.runOnMainSync { view(a)!!.loadUrl("http://127.0.0.1:1/owned-unreachable") }
            await("Sustained network refusal must expose reload", 11500) { panel(a).visibility == View.VISIBLE && panel(a).getChildAt(1).visibility == View.VISIBLE }
            instrument.runOnMainSync { assertTrue((panel(a).getChildAt(0) as android.widget.TextView).text.contains("reconnecting")); panel(a).getChildAt(1).performClick(); fixture(view(a)!!) }
            await("Retry after connection restoration must render") { panel(a).visibility == View.GONE }
        } finally { instrument.runOnMainSync { a.finish() } }
    }
    @Test fun blankDocumentRetriesWithoutJavaScriptOrTap() {
        lateinit var web: WebView
        lateinit var startup: GatewayStartup
        var retries = 0
        instrument.runOnMainSync {
            web = WebView(context)
            startup = GatewayStartup(web) { retries++; startup.ready() }
            startup.loading()
        }
        try {
            await("Native watchdog must retry without JavaScript or a manual tap", 15000) { retries == 1 }
            instrument.runOnMainSync { assertEquals(View.GONE, startup.getChildAt(1).visibility) }
        } finally { instrument.runOnMainSync { startup.close(); web.destroy() } }
    }
    @Test fun populatedUnbootedDocumentRetriesWithoutATap() {
        lateinit var web: WebView
        lateinit var startup: GatewayStartup
        val loaded = CountDownLatch(1)
        var retries = 0
        instrument.runOnMainSync {
            web = WebView(context).apply { settings.javaScriptEnabled = true }
            startup = GatewayStartup(web) { retries++; web.loadDataWithBaseURL(BETA_ORIGIN, "<body>Recovered app<script>document.documentElement.dataset.appStarted='true'</script></body>", "text/html", "UTF-8", BETA_ORIGIN) }
            web.webViewClient = object : android.webkit.WebViewClient() {
                override fun onPageStarted(v: WebView, url: String, icon: android.graphics.Bitmap?) { startup.loading(url) }
                override fun onPageFinished(v: WebView, url: String) { startup.inspect(); loaded.countDown() }
            }
            web.loadDataWithBaseURL(BETA_ORIGIN, "<body>Loading conversation forever</body>", "text/html", "UTF-8", BETA_ORIGIN)
        }
        try {
            assertTrue("Actual populated document loaded", loaded.await(5, TimeUnit.SECONDS))
            assertEquals("\"Loading conversation forever\"", js(web, "document.body.innerText"))
            await("A nonempty unbooted document must retain automatic recovery", 15000) { retries == 1 }
            await("The successful app boot retires native recovery") { startup.getChildAt(1).visibility == View.GONE }
            assertEquals("\"Recovered app\"", js(web, "document.body.innerText"))
        } finally { instrument.runOnMainSync { startup.close(); web.destroy() } }
    }
    @Test fun detachedDeadRendererIsRemovedFromWarmCache() {
        val a = instrument.startActivitySync(Intent(context, MainActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)) as MainActivity
        val key = WarmPages.Key(BETA_ORIGIN, "owned-session", WarmPages.Target.Thread("owned-cache", "owned-domain", "owned-chat"))
        try {
            lateinit var cached: WebView
            val loaded = CountDownLatch(1)
            instrument.runOnMainSync {
                fixture(view(a)!!)
                cached = WebView(android.content.MutableContextWrapper(a))
                cached.webViewClient = object : android.webkit.WebViewClient() {
                    override fun onPageFinished(v: WebView, url: String) { loaded.countDown() }
                }
                cached.settings.javaScriptEnabled = true
                cached.loadDataWithBaseURL(BETA_ORIGIN, "<body>Owned cache page</body>", "text/html", "UTF-8", BETA_ORIGIN)
            }
            assertTrue("Owned cache document loaded", loaded.await(5, TimeUnit.SECONDS))
            assertEquals("\"Owned cache page\"", js(cached, "document.body.innerText"))
            instrument.runOnMainSync { WarmPages.put(key, WarmPages.Page(cached, null, WarmPages.Bridge())); cached.loadUrl("chrome://crash") }
            await("Renderer death must remove the detached cached page", 10000) {
                val pages = WarmPages::class.java.getDeclaredField("pages").apply { isAccessible = true }.get(WarmPages) as Map<*, *>
                pages.containsKey(key) == false
            }
            instrument.runOnMainSync { assertNull("A dead renderer must never be returned", WarmPages.take(key)) }
        } finally { instrument.runOnMainSync { a.finish(); WarmPages.clear() } }
    }
    private fun js(v: WebView, code: String): String {
        val done = CountDownLatch(1); var result = ""
        instrument.runOnMainSync { v.evaluateJavascript(code) { result = it; done.countDown() } }
        assertTrue("JavaScript answered", done.await(5, TimeUnit.SECONDS)); return result
    }
    @Test fun rendererCrashRecreatesPageWithoutKillingActivity() {
        val a = instrument.startActivitySync(Intent(context, MainActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)) as MainActivity
        try {
            val old = view(a)!!
            lateinit var initialLoad: CountDownLatch
            instrument.runOnMainSync { initialLoad = fixture(old) }
            assertTrue("Initial owned document navigation completed", initialLoad.await(5, TimeUnit.SECONDS))
            await("Owned document should render") { panel(a).visibility == View.GONE && old.progress == 100 }
            js(old, "localStorage.setItem('owned-startup-draft','retained');localStorage.setItem('owned-startup-receipt','original-id');true")
            instrument.runOnMainSync { CookieManager.getInstance().setCookie(BETA_ORIGIN, "kenan_session=owned-startup; Path=/"); old.loadUrl("chrome://crash") }
            await("Renderer crash should create a fresh WebView", 10000) { view(a) != null && view(a) !== old }
            lateinit var recoveredLoad: CountDownLatch
            instrument.runOnMainSync { assertFalse(a.isDestroyed); recoveredLoad = fixture(view(a)!!) }
            assertTrue("Recovered owned document navigation completed", recoveredLoad.await(5, TimeUnit.SECONDS))
            await("Recovered renderer should display document") { panel(a).visibility == View.GONE && view(a)!!.progress == 100 }
            val recovered = view(a)!!
            assertEquals("\"retained\"", js(recovered, "localStorage.getItem('owned-startup-draft')"))
            assertEquals("\"original-id\"", js(recovered, "localStorage.getItem('owned-startup-receipt')"))
            assertTrue(CookieManager.getInstance().getCookie(BETA_ORIGIN).contains("kenan_session=owned-startup"))
            instrument.runOnMainSync { recovered.loadUrl("chrome://crash") }
            await("Second crash must recreate the renderer automatically", 10000) { view(a) != null && view(a) !== recovered }
            instrument.runOnMainSync { fixture(view(a)!!) }
            await("Repeated renderer failure must recover without a tap") { panel(a).visibility == View.GONE }
            js(view(a)!!, "localStorage.removeItem('owned-startup-draft');localStorage.removeItem('owned-startup-receipt');true")
            instrument.runOnMainSync { CookieManager.getInstance().setCookie(BETA_ORIGIN, "kenan_session=; Max-Age=0; Path=/") }
        } finally { instrument.runOnMainSync { a.finish() } }
    }
}
