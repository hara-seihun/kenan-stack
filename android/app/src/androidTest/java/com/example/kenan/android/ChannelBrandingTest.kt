package com.example.kenan.android

import android.app.Notification
import android.app.NotificationManager
import android.content.Context
import android.content.ContextWrapper
import android.content.Intent
import android.os.Build
import android.view.ViewGroup
import android.webkit.WebView
import android.widget.Button
import android.widget.TextView
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import org.junit.Assert.*
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import java.net.URI
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit

@RunWith(AndroidJUnit4::class)
class ChannelBrandingTest : OwnedDeviceTest() {
    private val instrument get() = InstrumentationRegistry.getInstrumentation()
    private val context get() = instrument.targetContext
    private val args get() = InstrumentationRegistry.getArguments()
    private val expected get() = args.getString("appLabel") ?: error("Expected authority label is unset")
    @Before fun ownedChannel() {
        check(Build.HARDWARE in setOf("ranchu", "goldfish"))
        check(args.getString("ownedFixture") == "kenan-branding")
        check(args.getString("appChannel") == BuildConfig.RELEASE_CHANNEL)
        assertEquals(expected, APP_LABEL)
        assertEquals(BuildConfig.APPLICATION_ID, context.packageName)
    }
    @Test fun installedLauncherAndNativeRecoveryUseTheBuildChannel() {
        val pm = context.packageManager
        assertEquals(expected, context.applicationInfo.loadLabel(pm).toString())
        val launcher = pm.getLaunchIntentForPackage(context.packageName) ?: error("Launcher is missing")
        assertEquals(expected, pm.getActivityInfo(launcher.component!!, 0).loadLabel(pm).toString())
        assertEquals(expected, context.getString(R.string.app_name))
        instrument.runOnMainSync {
            val web = WebView(context)
            val startup = GatewayStartup(web) {}
            try {
                startup.loading()
                val panel = startup.getChildAt(1) as ViewGroup
                assertEquals("Opening $expected…", (panel.getChildAt(0) as TextView).text.toString())
                startup.failed()
                assertTrue((panel.getChildAt(0) as TextView).text.toString().contains(expected))
                assertEquals("Reload $expected", (panel.getChildAt(1) as Button).text.toString())
            } finally { startup.close(); web.destroy() }
        }
    }
    @Test fun realNativeSetupAndNotificationBuilderUseTheSameLabel() {
        val store = DeviceStore(context)
        val prior = store.prefs.all
        store.prefs.edit().putBoolean("connectionEnabled", false).putBoolean("phoneEnabled", false).putBoolean("noticePermissionRequested", true).commit()
        val activity = instrument.startActivitySync(Intent(context, MainActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)) as MainActivity
        try {
            instrument.runOnMainSync {
                MainActivity::class.java.getDeclaredMethod("showSetup").apply { isAccessible = true }.invoke(activity)
                val header = MainActivity::class.java.getDeclaredField("setupHeader").apply { isAccessible = true }.get(activity) as TextView
                assertTrue(header.text.toString().startsWith(expected + "\n"))
                assertTrue(header.text.toString().contains(BuildConfig.VERSION_NAME))
            }
        } finally {
            instrument.runOnMainSync { activity.finish() }
            val edit=store.prefs.edit()
            for (key in listOf("connectionEnabled", "phoneEnabled", "noticePermissionRequested")) {
                val value=prior[key];if(value is Boolean)edit.putBoolean(key,value) else edit.remove(key)
            }
            edit.commit();store.close()
        }
    }
    @Test fun compiledWebLoginAndAboutDeclareTheMatchingServingChannel() {
        val target = args.getString("webFixtureUrl") ?: error("Owned loopback web fixture URL is unset")
        val uri = URI(target)
        check(uri.scheme == "http" && uri.host == "127.0.0.1" && uri.port > 0)
        val loaded=CountDownLatch(1);lateinit var web:WebView
        instrument.runOnMainSync {
            web=WebView(context);web.settings.javaScriptEnabled=true
            web.webViewClient=object:android.webkit.WebViewClient(){override fun onPageFinished(v:WebView,url:String){loaded.countDown()}}
            web.loadUrl(target)
        }
        try {
            assertTrue("Owned compiled web did not load",loaded.await(10,TimeUnit.SECONDS))
            assertEquals("\"$expected\"",js(web,"document.title"))
            assertEquals("\"${BuildConfig.RELEASE_CHANNEL}\"",js(web,"document.documentElement.dataset.appChannel"))
            val end=System.currentTimeMillis()+10000
            var surface=""
            while(System.currentTimeMillis()<end){js(web,"Array.from(document.querySelectorAll('button')).find(b=>b.textContent.trim()==='Settings')?.click()");surface=js(web,"document.body.innerText");if(surface.contains(expected)&&surface.contains("About"))break;Thread.sleep(50)}
            assertTrue("Real compiled About/Settings is absent: $surface",surface.contains("About $expected"))
            assertTrue(surface.contains(BuildConfig.RELEASE_CHANNEL))
        } finally { instrument.runOnMainSync { web.destroy() } }
    }
    private fun js(web:WebView,code:String):String {
        val done=CountDownLatch(1);var result=""
        instrument.runOnMainSync { web.evaluateJavascript(code){result=it;done.countDown()} }
        assertTrue(done.await(5,TimeUnit.SECONDS));return result
    }
}
