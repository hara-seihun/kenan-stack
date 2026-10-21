package com.example.kenan.android

import android.content.Intent
import android.webkit.WebView
import androidx.core.view.ViewCompat
import androidx.core.view.WindowInsetsCompat
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import androidx.test.uiautomator.UiDevice
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test
import org.junit.runner.RunWith
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit

@RunWith(AndroidJUnit4::class)
class ChatKeyboardTest : OwnedDeviceTest() {
    private val instrumentation get() = InstrumentationRegistry.getInstrumentation()
    private val context get() = instrumentation.targetContext
    private fun js(web: WebView, script: String): String {
        val done = CountDownLatch(1); var value = ""
        instrumentation.runOnMainSync { web.evaluateJavascript(script) { value = it; done.countDown() } }
        assertTrue("WebView responds", done.await(5, TimeUnit.SECONDS)); return value
    }
    private fun await(message: String, predicate: () -> Boolean) {
        val until = System.currentTimeMillis() + 6000
        while (System.currentTimeMillis() < until) { if (predicate()) return; Thread.sleep(30) }
        assertTrue(message, predicate())
    }
    @Test fun floatingConversationResizesAboveRealKeyboardAndRestores() = keyboard(BubbleActivity::class.java)
    @Test fun fullAppResizesAboveRealKeyboardAndRestores() = keyboard(MainActivity::class.java)

    private fun keyboard(type: Class<out MainActivity>) {
        val device = UiDevice.getInstance(instrumentation)
        androidx.test.uiautomator.Configurator.getInstance().waitForIdleTimeout = 0
        device.wakeUp(); device.executeShellCommand("wm dismiss-keyguard")
        val previousHardwareKeyboard = device.executeShellCommand("settings get secure show_ime_with_hard_keyboard").trim()
        device.executeShellCommand("settings put secure show_ime_with_hard_keyboard 1")
        val prefs = context.getSharedPreferences("kenan-next-device", android.content.Context.MODE_PRIVATE)
        val savedPrefs = prefs.all.toMap()
        prefs.edit().putBoolean("connectionEnabled", false).putBoolean("noticePermissionRequested", true).putBoolean("chatHeadEnabled", false).commit()
        context.stopService(Intent(context, NoticeService::class.java))
        val overlayMode = Regex("SYSTEM_ALERT_WINDOW: ([a-z]+)").find(device.executeShellCommand("cmd appops get ${context.packageName} SYSTEM_ALERT_WINDOW"))?.groupValues?.get(1) ?: "default"
        // Use the real head-to-editor route with an isolated fixture identity, never credentials.
        try {
        val activity = if (type == BubbleActivity::class.java) {
            device.executeShellCommand("cmd appops set ${context.packageName} SYSTEM_ALERT_WINDOW allow")
            DeviceStore(context).use { it.bind("keyboard-owner", "keyboard-epoch", "keyboard-domain") }
            prefs.edit().putBoolean("chatHeadEnabled", true).commit()
            device.pressHome()
            instrumentation.runOnMainSync { ChatHeads.offer(context, "keyboard-owner", "keyboard-domain", "keyboard-chat", "Kenaznia", select = true) }
            val head = device.wait(androidx.test.uiautomator.Until.findObject(androidx.test.uiautomator.By.desc("Open floating chat")), 5000)
            assertNotNull("The Kenaznia face head is available outside the app", head)
            device.takeScreenshot(java.io.File(context.getExternalFilesDir(null), "keyboard-chat-head.png"))
            head.click()
            var opened: BubbleActivity? = null
            await("Tapping the head opens the normal floating application window") {
                instrumentation.runOnMainSync { opened = androidx.test.runner.lifecycle.ActivityLifecycleMonitorRegistry.getInstance().getActivitiesInStage(androidx.test.runner.lifecycle.Stage.RESUMED).filterIsInstance<BubbleActivity>().firstOrNull() }
                opened != null
            }
            opened!!
        } else instrumentation.startActivitySync(Intent(context, type).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)) as MainActivity
        try {
            if (type == BubbleActivity::class.java) device.wait(androidx.test.uiautomator.Until.findObject(androidx.test.uiautomator.By.text(java.util.regex.Pattern.compile("not now", java.util.regex.Pattern.CASE_INSENSITIVE))), 2000)?.click()
            val web = MainActivity::class.java.getDeclaredField("web").apply { isAccessible = true }.get(activity) as WebView
            lateinit var loaded: CountDownLatch
            instrumentation.runOnMainSync {
                loaded = loadOwnedConversationPage(web, BETA_ORIGIN + "/?keyboard-fixture=1", """
                    <html><head><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover"/>
                    <style>html,body{margin:0;background:#000;color:#fff}main{height:100dvh;display:flex;flex-direction:column;box-sizing:border-box;padding:8px}section{flex:1;min-height:0;overflow:auto}textarea{box-sizing:border-box;width:100%;height:64px;flex-shrink:0;background:#222;color:white;font-size:18px}</style></head>
                    <body><main><header>Keyboard layout fixture</header><section>Conversation messages</section><textarea id="composer" aria-label="Message fixture">Keep my draft</textarea></main></body></html>
                """.trimIndent())
            }
            assertTrue("Owned keyboard document navigation completed", loaded.await(5, TimeUnit.SECONDS))
            await("Native opening surface is gone and the chat window has focus") {
                var ready = false
                instrumentation.runOnMainSync {
                    val startup = MainActivity::class.java.getDeclaredField("startup").apply { isAccessible = true }.get(activity) as GatewayStartup
                    ready = startup.getChildAt(1).visibility == android.view.View.GONE && activity.hasWindowFocus()
                }
                ready
            }
            await("Composer fixture loaded") { js(web, "Boolean(document.getElementById('composer'))") == "true" }
            var closedHeight = 0; var tapX = 0; var tapY = 0
            val rect = JSONObject(js(web, "JSON.stringify((()=>{const r=document.getElementById('composer').getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2,width:innerWidth}})())").let { org.json.JSONTokener(it).nextValue() as String })
            instrumentation.runOnMainSync {
                closedHeight = web.height
                val position = IntArray(2); web.getLocationOnScreen(position)
                val scale = web.width / rect.getDouble("width")
                tapX = position[0] + (rect.getDouble("x") * scale).toInt(); tapY = position[1] + (rect.getDouble("y") * scale).toInt()
                assertEquals("The chat is a normal application window for dictation overlays", android.view.WindowManager.LayoutParams.TYPE_BASE_APPLICATION, activity.window.attributes.type)
            }
            device.click(tapX, tapY)
            fun keyboardVisible(): Boolean { var visible = false; instrumentation.runOnMainSync { visible = ViewCompat.getRootWindowInsets(activity.window.decorView)?.isVisible(WindowInsetsCompat.Type.ime()) == true }; return visible }
            await("Real Android keyboard is visible", ::keyboardVisible)
            await("WebView physically shrinks for the keyboard") { var smaller = false; instrumentation.runOnMainSync { smaller = web.height < closedHeight - 80 }; smaller }
            Thread.sleep(350)
            var openedHeight = 0; var webBottom = 0; var keyboardTop = 0
            instrumentation.runOnMainSync {
                openedHeight = web.height
                val position = IntArray(2); web.getLocationOnScreen(position); webBottom = position[1] + web.height
                val decor = activity.window.decorView; decor.getLocationOnScreen(position)
                keyboardTop = position[1] + decor.height - ViewCompat.getRootWindowInsets(decor)!!.getInsets(WindowInsetsCompat.Type.ime()).bottom
                assertTrue("Composer WebView ends above IME: $webBottom <= $keyboardTop", webBottom <= keyboardTop + 2)
            }
            assertEquals("Composer remains in the viewport", "true", js(web, "document.getElementById('composer').getBoundingClientRect().bottom <= visualViewport.height + 1"))
            assertEquals("Draft survives layout changes", "\"Keep my draft\"", js(web, "document.getElementById('composer').value"))
            device.takeScreenshot(java.io.File(context.getExternalFilesDir(null), "keyboard-${type.simpleName}.png"))
            device.pressBack()
            await("Keyboard closes without closing chat") { !keyboardVisible() }
            await("Original WebView height is restored") { var restored = false; instrumentation.runOnMainSync { restored = kotlin.math.abs(web.height - closedHeight) <= 2 }; restored }
            assertFalse(activity.isFinishing)
            java.io.File(context.getExternalFilesDir(null), "keyboard-${type.simpleName}.json").writeText(JSONObject()
                .put("closedHeight", closedHeight).put("keyboardOpenHeight", openedHeight).put("webBottom", webBottom).put("keyboardTop", keyboardTop)
                .put("draftPreserved", true).put("restored", true).toString())
        } finally {
            instrumentation.runOnMainSync { activity.finish() }
        }
        } finally {
            val restored = prefs.edit().clear()
            savedPrefs.forEach { (key, value) -> when (value) {
                is String -> restored.putString(key, value); is Boolean -> restored.putBoolean(key, value)
                is Int -> restored.putInt(key, value); is Long -> restored.putLong(key, value); is Float -> restored.putFloat(key, value)
                is Set<*> -> @Suppress("UNCHECKED_CAST") restored.putStringSet(key, value as Set<String>)
            } }
            restored.commit()
            instrumentation.runOnMainSync { ChatHeads.close() }
            if (type == BubbleActivity::class.java) device.executeShellCommand("cmd appops set ${context.packageName} SYSTEM_ALERT_WINDOW $overlayMode")
            if (previousHardwareKeyboard == "null") device.executeShellCommand("settings delete secure show_ime_with_hard_keyboard")
            else device.executeShellCommand("settings put secure show_ime_with_hard_keyboard $previousHardwareKeyboard")
        }
    }
}
