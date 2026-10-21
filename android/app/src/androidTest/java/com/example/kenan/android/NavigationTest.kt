package com.example.kenan.android

import android.content.pm.ActivityInfo
import android.webkit.WebView
import androidx.core.view.ViewCompat
import androidx.core.view.WindowInsetsCompat
import androidx.test.core.app.ActivityScenario
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import androidx.test.uiautomator.UiDevice
import org.junit.Assert.*
import org.junit.Test
import org.junit.runner.RunWith

@RunWith(AndroidJUnit4::class)
class NavigationTest {
    @Test fun rotationAndSettingsKeepSameLiveConversation() {
        ActivityScenario.launch(MainActivity::class.java).use { scenario ->
            var original: MainActivity? = null
            var originalWeb: WebView? = null
            val field = MainActivity::class.java.getDeclaredField("web").apply { isAccessible = true }
            scenario.onActivity { activity ->
                original = activity
                originalWeb = field.get(activity) as WebView
                assertSame(originalWeb, activity.findViewById<android.view.View>(android.R.id.content).let { ((it as android.view.ViewGroup).getChildAt(0) as android.view.ViewGroup).getChildAt(0) })
                assertEquals("https://beta.kenan.example.com", DeviceStore(activity).prefs.getString("gateway", null))
                activity.requestedOrientation = ActivityInfo.SCREEN_ORIENTATION_LANDSCAPE
            }
            InstrumentationRegistry.getInstrumentation().waitForIdleSync()
            scenario.onActivity { activity ->
                assertSame(original, activity); assertSame(originalWeb, field.get(activity))
                val frame = originalWeb!!.parent as android.view.View
                val insets = ViewCompat.getRootWindowInsets(frame)!!
                val safe = insets.getInsets(WindowInsetsCompat.Type.systemBars() or WindowInsetsCompat.Type.displayCutout() or WindowInsetsCompat.Type.ime())
                assertEquals(safe.top, frame.paddingTop); assertEquals(safe.bottom, frame.paddingBottom)
                assertEquals(safe.left, frame.paddingLeft); assertEquals(safe.right, frame.paddingRight)
                MainActivity::class.java.getDeclaredMethod("showSetup").apply { isAccessible = true }.invoke(activity)
                assertSame(originalWeb, field.get(activity))
                activity.onBackPressed()
                assertSame(originalWeb, field.get(activity))
                assertSame(originalWeb, ((activity.findViewById<android.view.View>(android.R.id.content) as android.view.ViewGroup).getChildAt(0) as android.view.ViewGroup).getChildAt(0))
            }
            UiDevice.getInstance(InstrumentationRegistry.getInstrumentation()).unfreezeRotation()
        }
    }
}
