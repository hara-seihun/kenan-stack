package com.example.kenan.android

import android.content.Context
import android.content.Intent
import android.graphics.Color
import android.graphics.drawable.ColorDrawable
import android.os.Build
import androidx.core.view.ViewCompat
import androidx.core.view.WindowInsetsCompat
import androidx.test.core.app.ActivityScenario
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import androidx.test.uiautomator.By
import androidx.test.uiautomator.UiDevice
import androidx.test.uiautomator.Until
import org.junit.Assert.*
import org.junit.Test
import org.junit.runner.RunWith

@RunWith(AndroidJUnit4::class)
class AutomaticUpdateTest {
    private val instrument get() = InstrumentationRegistry.getInstrumentation()
    private val context get() = instrument.targetContext
    @Test fun blackInsetBackgroundAndSafeContent() {
        check(Build.HARDWARE in setOf("ranchu", "goldfish"))
        ActivityScenario.launch(MainActivity::class.java).use { scenario ->
            instrument.waitForIdleSync()
            scenario.onActivity { activity ->
                val container = activity.findViewById<android.view.ViewGroup>(android.R.id.content)
                val frame = container.getChildAt(0)
                assertEquals(Color.BLACK, (frame.background as ColorDrawable).color)
                assertEquals(Color.BLACK, (activity.window.decorView.background as ColorDrawable).color)
                val safe = ViewCompat.getRootWindowInsets(frame)!!.getInsets(WindowInsetsCompat.Type.systemBars() or WindowInsetsCompat.Type.displayCutout() or WindowInsetsCompat.Type.ime())
                assertEquals(safe.top, frame.paddingTop); assertEquals(safe.bottom, frame.paddingBottom)
                assertEquals(safe.left, frame.paddingLeft); assertEquals(safe.right, frame.paddingRight)
            }
        }
    }
    @Test fun signedForegroundCheckSubmitsOneInstallerSession() {
        check(Build.HARDWARE in setOf("ranchu", "goldfish"))
        val arguments = InstrumentationRegistry.getArguments()
        check(arguments.getString("ownedFixture") == "kenan-beta")
        val origin = arguments.getString("updateOrigin") ?: throw AssertionError("Fixture origin unset")
        val prefs = context.getSharedPreferences("kenan-next-device", Context.MODE_PRIVATE)
        check(prefs.edit().putString("qa-retained", "owned-update-fixture").commit())
        if (prefs.contains("autoUpdateSession")) {
            check(prefs.getString("autoUpdateState", null) == "installed" && prefs.getLong("autoUpdateVersion", -1) <= context.packageManager.getPackageInfo(context.packageName, 0).longVersionCode) { "Fixture has unresolved prior installer custody" }
        }
        ActivityScenario.launch(MainActivity::class.java).use { scenario ->
            var automatic: AutomaticUpdates? = null
            scenario.onActivity { activity ->
                (MainActivity::class.java.getDeclaredField("automaticUpdates").apply { isAccessible = true }.get(activity) as AutomaticUpdates).close()
                automatic = AutomaticUpdates(activity, origin) { }
                automatic!!.resume()
            }
            val device = UiDevice.getInstance(instrument)
            val prompt = device.wait(Until.findObject(By.text("Update")), 40000)
            assertNotNull("Automatic signed feed check did not reach Android consent: ${prefs.getString("updateCheckStatus", null)}", prompt)
            val session = prefs.getInt("autoUpdateSession", -1)
            assertTrue(session >= 0)
            assertEquals("awaiting-android-consent", prefs.getString("autoUpdateState", null))
            scenario.onActivity {
                automatic!!.pause(); automatic!!.resume()
                assertEquals(session, prefs.getInt("autoUpdateSession", -1))
                assertTrue(automatic!!.retry() is Outcome.Err)
                automatic!!.close()
            }
            java.io.File(context.getExternalFilesDir(null), "automatic-update-proof.json").writeText(org.json.JSONObject()
                .put("sessionId", session).put("versionCode", prefs.getLong("autoUpdateVersion", -1)).put("state", prefs.getString("autoUpdateState", null)).toString())
        }
    }
    @Test fun installedUpdateRetainsDeviceIdentityAndInstallerEvidence() {
        val arguments = InstrumentationRegistry.getArguments()
        val version = arguments.getString("versionCode")!!.toLong()
        assertEquals(version, context.packageManager.getPackageInfo(context.packageName, 0).longVersionCode)
        val prefs = context.getSharedPreferences("kenan-next-device", Context.MODE_PRIVATE)
        assertEquals("owned-update-fixture", prefs.getString("qa-retained", null))
        assertEquals("installed", prefs.getString("autoUpdateState", null))
        assertEquals(version, prefs.getLong("autoUpdateVersion", -1))
    }
}
