package com.example.kenan.android

import android.content.Intent
import android.net.Uri
import android.os.Build
import android.webkit.ValueCallback
import android.webkit.WebChromeClient
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import androidx.test.uiautomator.By
import androidx.test.uiautomator.UiDevice
import androidx.test.uiautomator.Until
import org.junit.Assert.*
import org.junit.Test
import org.junit.runner.RunWith
import java.util.concurrent.CopyOnWriteArrayList

@RunWith(AndroidJUnit4::class)
class AttachmentChooserTest : OwnedDeviceTest() {
    private val instrumentation get() = InstrumentationRegistry.getInstrumentation()
    private val device get() = UiDevice.getInstance(instrumentation)
    private fun params(accept: Array<String>, capture: Boolean = false) = object : WebChromeClient.FileChooserParams() {
        override fun getMode() = MODE_OPEN
        override fun getAcceptTypes() = accept
        override fun isCaptureEnabled() = capture
        override fun getTitle(): CharSequence? = null
        override fun getFilenameHint(): String? = null
        override fun createIntent() = Intent(Intent.ACTION_GET_CONTENT).setType("*/*").addCategory(Intent.CATEGORY_OPENABLE)
    }
    private fun await(test: () -> Boolean) {
        val until = System.currentTimeMillis() + 10000
        while (!test() && System.currentTimeMillis() < until) Thread.sleep(50)
        assertTrue("Timed out waiting for fixture outcome", test())
    }
    @Test fun systemPickersCancelAndCameraReturnsFullSizeContentUri() {
        check(Build.HARDWARE in setOf("ranchu", "goldfish"))
        check(InstrumentationRegistry.getArguments().getString("ownedFixture") == "kenan-beta")
        val context = instrumentation.targetContext
        // Caller isolates the retained emulator from the network before instrumentation.
        check(device.executeShellCommand("settings get global wifi_on").trim() == "0")
        device.executeShellCommand("pm grant ${context.packageName} android.permission.CAMERA")
        device.wakeUp(); device.executeShellCommand("wm dismiss-keyguard")
        DeviceStore(context).use { it.prefs.edit().putBoolean("connectionEnabled", false).putBoolean("phoneEnabled", false).putBoolean("noticePermissionRequested", true).commit() }
        val activity = instrumentation.startActivitySync(Intent(context, MainActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)) as MainActivity
        // Picker ownership belongs to a loaded document. Leaving the Activity's
        // real offline startup running would correctly invalidate this fixture's
        // callback on every automatic navigation retry while the camera is open.
        lateinit var loaded: java.util.concurrent.CountDownLatch
        instrumentation.runOnMainSync {
            val web = MainActivity::class.java.getDeclaredField("web").apply { isAccessible=true }.get(activity) as android.webkit.WebView
            loaded = loadOwnedConversationPage(web, "$BETA_ORIGIN/", "<body>Owned attachment conversation</body>")
        }
        assertTrue("Owned attachment document loaded", loaded.await(5, java.util.concurrent.TimeUnit.SECONDS))
        val chooser = MainActivity::class.java.getDeclaredField("attachments").apply { isAccessible = true }.get(activity) as AttachmentChooser
        val results = CopyOnWriteArrayList<List<Uri>>()
        val callback = ValueCallback<Array<Uri>> { results.add(it?.toList() ?: emptyList()) }
        try {
            instrumentation.runOnMainSync { chooser.open(params(arrayOf("image/*")), callback, "owned-fixture") { true } }
            assertNotNull(device.wait(Until.findObject(By.textContains("Photos")), 10000))
            val rejected = CopyOnWriteArrayList<List<Uri>>()
            instrumentation.runOnMainSync { chooser.open(params(emptyArray()), ValueCallback { rejected.add(it?.toList() ?: emptyList()) }, "owned-fixture") { true } }
            assertEquals(listOf(emptyList<Uri>()), rejected)
            device.pressBack(); await { results.size == 1 }; assertTrue(results[0].isEmpty())
            instrumentation.runOnMainSync { chooser.open(params(emptyArray()), callback, "owned-fixture") { true } }
            assertNotNull(device.wait(Until.findObject(By.pkg("com.google.android.documentsui")), 10000))
            // Navigation invalidates the callback exactly once; the late result is drained.
            instrumentation.runOnMainSync { chooser.cancel() }
            assertEquals(2, results.size)
            device.pressBack(); Thread.sleep(300); assertEquals(2, results.size)
            instrumentation.runOnMainSync { chooser.open(params(arrayOf("image/*"), true), callback, "owned-fixture") { true } }
            assertNotNull(device.wait(Until.findObject(By.pkg("com.android.camera2")), 10000))
            val shutter = device.wait(Until.findObject(By.descContains("Shutter")), 10000)
                ?: device.wait(Until.findObject(By.res("com.android.camera2", "shutter_button")), 3000)
            assertNotNull("Camera shutter", shutter); shutter!!.click()
            val done = device.wait(Until.findObject(By.descContains("Done")), 10000)
                ?: device.wait(Until.findObject(By.res("com.android.camera2", "done_button")), 3000)
            assertNotNull("Camera confirmation", done); done!!.click()
            await { results.size == 3 }
            val uri = results[2].single()
            assertEquals("content", uri.scheme); assertEquals(context.packageName + ".attachments", uri.authority)
            context.contentResolver.openInputStream(uri).use { assertTrue(it!!.readBytes().size > 1024) }
            assertFalse(context.getSharedPreferences("attachment-capture", 0).contains("file"))
            context.contentResolver.delete(uri, null, null)
            // Losing the document callback while the camera owns the screen must retain
            // its full-size output for a deliberate same-session retry.
            instrumentation.runOnMainSync { chooser.open(params(arrayOf("image/*"), true), callback, "owned-fixture") { true } }
            assertNotNull(device.wait(Until.findObject(By.pkg("com.android.camera2")), 10000))
            instrumentation.runOnMainSync { chooser.cancel() }
            assertEquals(4, results.size); assertTrue(results[3].isEmpty())
            device.wait(Until.findObject(By.res("com.android.camera2", "shutter_button")), 10000)!!.click()
            device.wait(Until.findObject(By.res("com.android.camera2", "done_button")), 10000)!!.click()
            assertNotNull(device.wait(Until.findObject(By.text("Photo saved. Tap the camera button again to attach it.")), 10000))
            device.findObject(By.text("OK"))!!.click()
            assertEquals(4, results.size)
            assertTrue(context.getSharedPreferences("attachment-capture", 0).getBoolean("ready", false))
            instrumentation.runOnMainSync { chooser.open(params(arrayOf("image/*"), true), callback, "owned-fixture") { true } }
            await { results.size == 5 }
            val recovered = results[4].single()
            context.contentResolver.openInputStream(recovered).use { assertTrue(it!!.readBytes().size > 1024) }
            assertFalse(context.getSharedPreferences("attachment-capture", 0).contains("file"))
            context.contentResolver.delete(recovered, null, null)
        } finally { instrumentation.runOnMainSync { chooser.cancel(); activity.finish() } }
    }
    @Test fun cameraBytesReachActualWebViewFileInput() {
        check(Build.HARDWARE in setOf("ranchu", "goldfish"))
        check(InstrumentationRegistry.getArguments().getString("ownedFixture") == "kenan-beta")
        check(device.executeShellCommand("settings get global wifi_on").trim() == "0")
        val context = instrumentation.targetContext
        DeviceStore(context).use { it.prefs.edit().putBoolean("connectionEnabled", false).putBoolean("phoneEnabled", false).putBoolean("noticePermissionRequested", true).commit() }
        val activity = instrumentation.startActivitySync(Intent(context, MainActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)) as MainActivity
        // Picker ownership belongs to a loaded document. Leaving the Activity's
        // real offline startup running would correctly invalidate this fixture's
        // callback on every automatic navigation retry while the camera is open.
        lateinit var loaded: java.util.concurrent.CountDownLatch
        instrumentation.runOnMainSync {
            val web = MainActivity::class.java.getDeclaredField("web").apply { isAccessible=true }.get(activity) as android.webkit.WebView
            loaded = loadOwnedConversationPage(web, "$BETA_ORIGIN/", "<body>Owned attachment conversation</body>")
        }
        assertTrue("Owned attachment document loaded", loaded.await(5, java.util.concurrent.TimeUnit.SECONDS))
        val chooser = MainActivity::class.java.getDeclaredField("attachments").apply { isAccessible = true }.get(activity) as AttachmentChooser
        var view: android.webkit.WebView? = null
        val before = java.io.File(context.filesDir, "attachments").listFiles()?.toSet() ?: emptySet()
        try {
            instrumentation.runOnMainSync {
                view = android.webkit.WebView(activity).apply {
                    settings.javaScriptEnabled = true; settings.allowFileAccess = false; settings.allowContentAccess = false
                    webChromeClient = object : WebChromeClient() {
                        override fun onShowFileChooser(v: android.webkit.WebView, callback: ValueCallback<Array<Uri>>, params: FileChooserParams): Boolean {
                            chooser.open(params, callback, "owned-fixture") { true }; return true
                        }
                    }
                }
                activity.setContentView(view)
                view!!.loadDataWithBaseURL("https://owned-fixture.invalid/", """<meta name="viewport" content="width=device-width,initial-scale=1"><button style="font-size:24px;height:100px" onclick="document.querySelector('input').click()">Camera fixture</button><input type="file" accept="image/*" capture="environment" hidden><p id="result"></p><script>document.querySelector('input').onchange=async e=>{document.querySelector('#result').textContent='Camera bytes '+(await e.target.files[0].arrayBuffer()).byteLength}</script>""", "text/html", "UTF-8", null)
            }
            device.wait(Until.findObject(By.text("Camera fixture")), 10000)!!.click()
            device.wait(Until.findObject(By.res("com.android.camera2", "shutter_button")), 10000)!!.click()
            device.wait(Until.findObject(By.res("com.android.camera2", "done_button")), 10000)!!.click()
            val result = device.wait(Until.findObject(By.textStartsWith("Camera bytes ")), 10000)
            assertNotNull("Captured bytes must reach JavaScript", result)
            assertTrue(result!!.text.removePrefix("Camera bytes ").toInt() > 1024)
        } finally {
            instrumentation.runOnMainSync { chooser.cancel(); view?.destroy(); activity.finish() }
            java.io.File(context.filesDir, "attachments").listFiles()?.filter { it !in before }?.forEach { it.delete() }
        }
    }

}
