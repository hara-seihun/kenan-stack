package com.example.kenan.android

import android.content.Intent
import android.os.Build
import android.webkit.WebView
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import androidx.test.uiautomator.UiDevice
import org.junit.Assert.*
import org.junit.Test
import org.junit.runner.RunWith
import java.net.ServerSocket
import java.util.concurrent.atomic.AtomicInteger

@RunWith(AndroidJUnit4::class)
class AppUpdateDownloadTest {
    @Test fun loginDownloadLinkChecksSignedChannelWithoutNavigatingAway() {
        check(Build.HARDWARE in setOf("ranchu", "goldfish"))
        val instrumentation = InstrumentationRegistry.getInstrumentation()
        check(InstrumentationRegistry.getArguments().getString("ownedFixture") == "kenan-beta")
        val device = UiDevice.getInstance(instrumentation)
        check(device.executeShellCommand("settings get global wifi_on").trim() == "0")
        val feed = java.io.File("/data/local/tmp/kenan-update-fixture.json").readBytes()
        val server = ServerSocket(0, 4, java.net.InetAddress.getByName("127.0.0.1"))
        val requests = AtomicInteger()
        val serving = Thread {
            try { server.accept().use { socket ->
                val reader = socket.getInputStream().bufferedReader()
                assertEquals("GET /api/android/release HTTP/1.1", reader.readLine())
                while (!reader.readLine().isNullOrEmpty()) { }
                requests.incrementAndGet()
                socket.getOutputStream().apply {
                    write("HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: ${feed.size}\r\nConnection: close\r\n\r\n".toByteArray())
                    write(feed); flush()
                }
            } } catch (_: java.net.SocketException) { }
        }.apply { start() }
        val activity = instrumentation.startActivitySync(Intent(instrumentation.targetContext, MainActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)) as MainActivity
        val updateField = MainActivity::class.java.getDeclaredField("automaticUpdates").apply { isAccessible = true }
        val view = MainActivity::class.java.getDeclaredField("web").apply { isAccessible = true }.get(activity) as WebView
        val outcomes = java.util.concurrent.CopyOnWriteArrayList<String>()
        try {
            instrumentation.runOnMainSync {
                (updateField.get(activity) as AutomaticUpdates).close()
                updateField.set(activity, AutomaticUpdates(activity, "http://127.0.0.1:${server.localPort}") { outcomes.add(it) })
                view.loadDataWithBaseURL("$BETA_ORIGIN/login", "<html><body><a id='apk' href='$BETA_ORIGIN/app.apk'>Download APK</a></body></html>", "text/html", "utf-8", null)
            }
            Thread.sleep(500)
            var pageBefore: String? = null
            instrumentation.runOnMainSync { pageBefore = view.url; view.evaluateJavascript("document.getElementById('apk').click()", null) }
            val until = System.currentTimeMillis() + 10000
            while (outcomes.isEmpty() && System.currentTimeMillis() < until) Thread.sleep(50)
            assertEquals(listOf("${APP_LABEL} is up to date"), outcomes)
            assertEquals(1, requests.get())
            instrumentation.runOnMainSync { assertEquals(pageBefore, view.url) }
        } finally {
            instrumentation.runOnMainSync { activity.finish() }
            server.close(); serving.join(1000)
        }
    }
}
