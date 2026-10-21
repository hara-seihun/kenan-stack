package com.example.kenan.android

import android.os.Build
import android.os.SystemClock
import android.webkit.WebView
import androidx.test.core.app.ActivityScenario
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import org.junit.Test
import org.junit.runner.RunWith
import java.io.File

/** Owned-emulator inspection session; debugging is never enabled by the shipped app. */
@RunWith(AndroidJUnit4::class)
class LatencyTest {
    @Test fun inspectInstalledWebView() {
        val instrument = InstrumentationRegistry.getInstrumentation()
        check(Build.HARDWARE in setOf("ranchu", "goldfish"))
        check(InstrumentationRegistry.getArguments().getString("ownedFixture") == "kenan-beta")
        val finish = File(instrument.targetContext.getExternalFilesDir(null), "latency-finish")
        finish.delete()
        instrument.runOnMainSync { WebView.setWebContentsDebuggingEnabled(true) }
        try {
            ActivityScenario.launch(MainActivity::class.java).use {
                val deadline = SystemClock.elapsedRealtime() + 45 * 60 * 1000
                while (!finish.exists() && SystemClock.elapsedRealtime() < deadline) SystemClock.sleep(200)
                check(finish.exists()) { "Owned latency session timed out" }
            }
        } finally {
            instrument.runOnMainSync { WebView.setWebContentsDebuggingEnabled(false) }
            finish.delete()
        }
    }
}
