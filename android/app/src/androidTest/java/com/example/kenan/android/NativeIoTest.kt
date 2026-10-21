package com.example.kenan.android

import android.os.Build
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test
import org.junit.runner.RunWith
import java.io.File

@RunWith(AndroidJUnit4::class)
class NativeIoTest : OwnedDeviceTest() {
    @Test fun installationRejectsUiThreadAndCancelledScopeCreatesNoSession() {
        check(Build.HARDWARE in setOf("ranchu", "goldfish"))
        val instrument = InstrumentationRegistry.getInstrumentation()
        check(InstrumentationRegistry.getArguments().getString("ownedFixture") == "kenan-beta")
        val context = instrument.targetContext
        val before = context.packageManager.packageInstaller.mySessions.map { it.sessionId }.toSet()
        var mainResult: Outcome<JSONObject>? = null
        instrument.runOnMainSync { mainResult = ApkUpdater(context).install(JSONObject()) }
        assertTrue(mainResult is Outcome.Err)
        assertTrue((mainResult as Outcome.Err).message.contains("worker"))
        val file = File.createTempFile("cancelled-update-test-", ".apk", context.cacheDir)
        try {
            // Instrumentation itself runs outside the UI thread; the scope cancels before any install.
            val result = ApkUpdater(context).install(JSONObject().put("path", file.path)) { false }
            assertTrue(result is Outcome.Err)
            assertFalse(file.exists())
            assertEquals(before, context.packageManager.packageInstaller.mySessions.map { it.sessionId }.toSet())
        } finally { file.delete() }
    }
}
