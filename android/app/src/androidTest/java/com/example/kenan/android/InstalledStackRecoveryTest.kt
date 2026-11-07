package com.example.kenan.android

import android.content.Intent
import android.graphics.Bitmap
import android.os.Build
import android.view.View
import android.webkit.*
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test
import org.junit.runner.RunWith
import java.net.HttpURLConnection
import java.net.URL
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit

@RunWith(AndroidJUnit4::class)
class InstalledStackRecoveryTest : OwnedDeviceTest() {
    private val instrument get() = InstrumentationRegistry.getInstrumentation()
    private val context get() = instrument.targetContext
    private fun field(a: MainActivity, key: String): Any? = MainActivity::class.java.getDeclaredField(key).apply { isAccessible = true }.get(a)
    private fun js(v: WebView, code: String): String {
        val done = CountDownLatch(1); var result = "null"
        instrument.runOnMainSync { v.evaluateJavascript(code) { result = it; done.countDown() } }
        check(done.await(5, TimeUnit.SECONDS)) { "WebView JS callback expired" }; return result
    }
    private fun data(v: WebView, code: String) = JSONObject(JSONArray("[" + js(v, "JSON.stringify(" + code + ")") + "]").getString(0))
    private fun control(origin: String, path: String, body: JSONObject? = null): JSONObject {
        val c = URL(origin + path).openConnection() as HttpURLConnection
        c.connectTimeout = 5000; c.readTimeout = 15000
        if (body != null) { c.requestMethod = "POST"; c.doOutput = true; c.setRequestProperty("Content-Type", "application/json"); c.outputStream.use { it.write(body.toString().toByteArray()) } }
        return try {
            val status = c.responseCode
            val stream = if(status in 200..299) c.inputStream else c.errorStream
            val text = stream?.bufferedReader()?.use { it.readText() } ?: "<empty body>"
            check(status in 200..299) { "Fixture $path HTTP$status: $text" }
            JSONObject(text)
        } finally { c.disconnect() }
    }
    private fun await(v: WebView, code: String, duration: Long = 15000) {
        val until = android.os.SystemClock.elapsedRealtime() + duration
        while (android.os.SystemClock.elapsedRealtime() < until) { if (js(v, code) == "true") return; Thread.sleep(50) }
        fail("Not reached: $code; " + js(v, "document.body.innerText"))
    }
    private fun stateUntil(ctl: String, key: String, count: Int): JSONObject {
        val until = android.os.SystemClock.elapsedRealtime() + 20000
        var state = control(ctl, "/state")
        while (android.os.SystemClock.elapsedRealtime() < until) {
            if (state.getInt(key) >= count) return state
            Thread.sleep(100); state = control(ctl, "/state")
        }
        fail("Fixture $key did not reach $count: $state"); return state
    }
    private fun edit(v: WebView, text: String) {
        js(v, "(()=>{const t=document.querySelector('.composer textarea');if(!t)throw Error('composer absent');Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set.call(t," + JSONObject.quote(text) + ");t.dispatchEvent(new Event('input',{bubbles:true}));t.focus();return true})()")
        await(v, "document.querySelector('.composer textarea')?.value===" + JSONObject.quote(text))
    }
    private fun send(v: WebView, text: String) {
        edit(v, text); await(v, "document.querySelector('button[aria-label=\"Send message\"]')?.disabled===false")
        js(v, "document.querySelector('button[aria-label=\"Send message\"]').click();true")
    }
    @Test fun signedNativeConsumesInstalledEdgeAuthAndRecovery() {
        check(Build.HARDWARE in setOf("ranchu", "goldfish"))
        val args = InstrumentationRegistry.getArguments()
        check(args.getString("ownedFixture") == "kenan-beta")
        val origin = args.getString("fixtureOrigin") ?: error("Explicit fixture origin required")
        val ctl = args.getString("controlOrigin") ?: error("Explicit control origin required")
        check(origin.startsWith("http://127.0.0.1:")); check(ctl.startsWith("http://127.0.0.1:"))
        val initial = control(ctl, "/state")
        val report = JSONObject().put("versionCode", BuildConfig.VERSION_CODE).put("package", context.packageName).put("cases", JSONArray())
        DeviceStore(context).use { check(it.prefs.edit().putBoolean("connectionEnabled", false).putBoolean("phoneEnabled", false).putBoolean("noticePermissionRequested", true).commit()) }
        val a = instrument.startActivitySync(Intent(context, MainActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)) as MainActivity
        val callbacks = JSONArray()
        try {
            instrument.runOnMainSync {
                (field(a,"automaticUpdates") as AutomaticUpdates).close()
                val gateway = (Gateway.parse(origin) as Outcome.Ok).value
                MainActivity::class.java.getDeclaredMethod("openGateway",Gateway::class.java,String::class.java,Boolean::class.javaPrimitiveType).apply { isAccessible = true }.invoke(a,gateway,origin + "/",false)
                val v = field(a,"web") as WebView; val original = v.webViewClient
                v.webViewClient = object : WebViewClient() {
                    override fun onPageStarted(v: WebView,url: String,icon: Bitmap?) { callbacks.put(JSONObject().put("kind","start"));original.onPageStarted(v,url,icon) }
                    override fun onPageCommitVisible(v: WebView,url: String) = original.onPageCommitVisible(v,url)
                    override fun onPageFinished(v: WebView,url: String) = original.onPageFinished(v,url)
                    override fun onReceivedError(v: WebView,r: WebResourceRequest,e: WebResourceError) { callbacks.put(JSONObject().put("kind","error").put("mainFrame",r.isForMainFrame).put("code",e.errorCode));original.onReceivedError(v,r,e) }
                    override fun onReceivedHttpError(v: WebView,r: WebResourceRequest,e: WebResourceResponse) { callbacks.put(JSONObject().put("kind","http").put("mainFrame",r.isForMainFrame).put("status",e.statusCode));original.onReceivedHttpError(v,r,e) }
                    override fun shouldOverrideUrlLoading(v: WebView,r: WebResourceRequest) = original.shouldOverrideUrlLoading(v,r)
                }
            }
            val v = field(a,"web") as WebView
            await(v, "document.readyState!=='loading'&&location.origin===" + JSONObject.quote(origin))
            val login = JSONObject().put("accountId",initial.getString("accountId")).put("secret",initial.getString("secret"))
            js(v, "window.nativeLogin=null;fetch('/api/login?startup=1',{method:'POST',headers:{'content-type':'application/json'},body:" + JSONObject.quote(login.toString()) + "}).then(async r=>{window.nativeLogin={status:r.status,result:await r.json()}}).catch(e=>window.nativeLogin={error:String(e)});true")
            await(v,"window.nativeLogin!==null")
            assertEquals(200,data(v,"window.nativeLogin").getInt("status"))
            val target = origin + "/?accountId=" + initial.getString("accountId") + "&conversationId=" + initial.getString("conversationId")
            instrument.runOnMainSync { v.loadUrl(target) }
            await(v,"document.querySelector('.conversation[data-history-ready=\"true\"]')!==null&&document.body.innerText.includes(" + JSONObject.quote(initial.getString("documentMarker")) + ")")
            edit(v,"Retain signed Stack draft")
            js(v,"window.nativeDocument=document;window.nativeComposer=document.querySelector('.composer textarea');nativeComposer.setSelectionRange(3,9);window.nativeReads=[];window.nativeFetch=window.fetch;window.fetch=async function(...args){const at=Date.now();try{const r=await nativeFetch.apply(this,args);nativeReads.push({at,end:Date.now(),url:String(args[0]),status:r.status});return r}catch(e){nativeReads.push({at,end:Date.now(),url:String(args[0]),error:String(e)});throw e}};window.nativeSamples=[];window.nativeMonitor=setInterval(()=>nativeSamples.push({at:Date.now(),same:document===nativeDocument&&nativeComposer.isConnected,draft:nativeComposer.value,start:nativeComposer.selectionStart,end:nativeComposer.selectionEnd,banner:/Can.t reach your home right now|Connection interrupted|Reconnecting…/.test(document.body.textContent),status:[...document.querySelectorAll('.connection')].map(n=>n.textContent)}),25);true")
            for(kind in listOf("edge-restart","account-restart")) {
                val before=data(v,"({count:nativeSamples.length})").getInt("count")
                js(v,"window.nativeRestartAt=Date.now();true")
                val restart=control(ctl,"/action",JSONObject().put("kind",kind).put("downMs",0))
                await(v,"nativeReads.some(r=>r.at>=nativeRestartAt&&r.url.includes('/api/snapshot?')&&r.status===200)&&[...document.querySelectorAll('.connection')].some(n=>n.textContent==='Home synchronized')",30000)
                instrument.runOnMainSync { assertSame(v,field(a,"web"));assertEquals(View.GONE,(field(a,"startup") as GatewayStartup).getChildAt(1).visibility) }
                report.getJSONArray("cases").put(JSONObject().put("kind",kind).put("restart",restart).put("samplesFrom",before))
            }
            js(v,"clearInterval(nativeMonitor)")
            val samples=data(v,"({samples:nativeSamples})").getJSONArray("samples")
            report.put("retentionSamples",samples).put("reads",data(v,"({reads:nativeReads})").getJSONArray("reads"))
            assertTrue(samples.length()>0)
            for(i in 0 until samples.length()) { val s=samples.getJSONObject(i);assertTrue(s.getBoolean("same"));assertEquals("Retain signed Stack draft",s.getString("draft"));assertEquals(3,s.getInt("start"));assertEquals(9,s.getInt("end"));assertFalse(s.getBoolean("banner")) }
            report.put("retentionSamples",samples)
            control(ctl,"/action",JSONObject().put("kind","admission-fault"))
            send(v,"NATIVE_ADMISSION_RETRY")
            val refused=stateUntil(ctl,"sendAttempts",1)
            assertEquals(0,refused.getInt("admittedInputs"))
            control(ctl,"/action",JSONObject().put("kind","admission-recover"))
            stateUntil(ctl,"admittedInputs",1)
            control(ctl,"/action",JSONObject().put("kind","lost-ack"))
            send(v,"NATIVE_ACK_LOSS")
            val lostAckState=stateUntil(ctl,"admittedInputs",2)
            val lostAckId=lostAckState.getJSONArray("commands").getJSONObject(1).getString("id")
            control(ctl,"/action",JSONObject().put("kind","projection-fault"))
            send(v,"NATIVE_PROJECTION_REPAIR")
            val projectionState=stateUntil(ctl,"admittedInputs",3)
            val projectionId=projectionState.getJSONArray("commands").getJSONObject(2).getString("id")
            // Receipt polling is application behavior; no resend gesture or manual reload is performed.
            for(marker in listOf("NATIVE_ADMISSION_RETRY","NATIVE_ACK_LOSS","NATIVE_PROJECTION_REPAIR")) {
                await(v,"[...document.querySelectorAll('.message[data-canonical-root-id] .message-body')].filter(n=>n.textContent===" + JSONObject.quote(marker) + ").length===1",20000)
            }
            await(v,"!document.body.innerText.includes('Not sent')&&!document.body.innerText.includes('Status unknown')",20000)
            for(id in listOf(lostAckId,projectionId)) {
                await(v,"nativeReads.some(r=>r.url.endsWith('/api/operations/" + id + "')&&r.status===200)",20000)
            }
            report.put("receiptReads",data(v,"({reads:nativeReads.filter(r=>r.url.includes('/api/operations/'))})").getJSONArray("reads"))
            val verified=control(ctl,"/action",JSONObject().put("kind","verify"))
            assertTrue("Backend exact-identity verification",verified.getBoolean("ok"))
            report.put("verification",verified).put("dom",data(v,"({text:document.body.innerText,rows:[...document.querySelectorAll('.message[data-canonical-root-id]')].map(n=>({id:n.dataset.canonicalRootId,text:n.innerText})),url:location.href})"))
            report.put("state","passed").put("callbacks",callbacks)
            control(ctl,"/report",report)
        } catch(e: Throwable) {
            report.put("state","failed").put("error",e.toString()).put("callbacks",callbacks)
            val failedView = field(a,"web") as? WebView
            if(failedView != null) report.put("observation",data(failedView,"({samples:window.nativeSamples,reads:window.nativeReads,text:document.body.innerText})"))
            java.io.File(context.getExternalFilesDir(null),"installed-stack-native.json").writeText(report.toString())
            control(ctl,"/report",report);throw e
        } finally {
            instrument.runOnMainSync { a.finish();WarmPages.clear();CookieManager.getInstance().setCookie(origin,"kenan_session=; Max-Age=0; Path=/") }
        }
    }
}
