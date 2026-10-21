package com.example.kenan.android

import android.webkit.WebView
import android.webkit.WebViewClient
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse

/** Exercise a real HTTPS document/navigation without reaching the personal server. */
internal fun loadOwnedConversationPage(view: WebView, url: String, html: String, status: () -> Int = { 200 }, onHttpError: () -> Unit = {}): java.util.concurrent.CountDownLatch {
    val completed = java.util.concurrent.CountDownLatch(1)
    // The Activity's original navigation can finish after this fixture starts.
    // Distinguish our actual document from that same-path completion; otherwise
    // assertions race a second navigation and Chromium drops their JS callbacks.
    val fixtureToken = java.util.UUID.randomUUID().toString()
    val targetUri = android.net.Uri.parse(url)
    val fixtureUrl = targetUri.buildUpon().appendQueryParameter("ownedFixture", fixtureToken).build().toString()
    // Delayed callbacks from the Activity's retired initial URL are still
    // forwarded to production, but cannot count as this fixture's failed load.
    // Only a successful response boots the fixture app; edge error HTML does not.
    fun ownsRequest(request: WebResourceRequest) = request.isForMainFrame && request.url.toString() == fixtureUrl
    fun document(code: Int) = html + "<script>window.__ownedFixtureToken='$fixtureToken';" +
        (if (code == 200) "document.documentElement.dataset.appStarted='true';" else "") + "</script>"
    view.stopLoading()
    val original = view.webViewClient
    view.webViewClient = object : WebViewClient() {
        override fun shouldInterceptRequest(v: WebView, request: WebResourceRequest): WebResourceResponse {
            val code = if (ownsRequest(request)) status() else 200
            return WebResourceResponse("text/html", "UTF-8", code, if (code == 200) "OK" else "Unavailable", emptyMap(), (if (request.isForMainFrame && request.url.host == targetUri.host && request.url.path == targetUri.path) document(code) else "").byteInputStream())
        }
        override fun onReceivedError(v: WebView, request: WebResourceRequest, error: android.webkit.WebResourceError) = original.onReceivedError(v, request, error)
        override fun onReceivedHttpError(v: WebView, request: WebResourceRequest, response: WebResourceResponse) {
            android.util.Log.i("OwnedDocument", "HTTP${response.statusCode} request=${request.url} current=${v.url} fixture=$fixtureUrl")
            original.onReceivedHttpError(v, request, response)
            if (ownsRequest(request)) onHttpError()
        }
        override fun onRenderProcessGone(v: WebView, detail: android.webkit.RenderProcessGoneDetail) = original.onRenderProcessGone(v, detail)
        override fun onPageCommitVisible(v: WebView, target: String) = original.onPageCommitVisible(v, target)
        override fun onPageStarted(v: WebView, target: String, icon: android.graphics.Bitmap?) {
            android.util.Log.i("OwnedDocument", "started $target")
            original.onPageStarted(v, target, icon)
        }
        override fun onPageFinished(v: WebView, target: String) {
            android.util.Log.i("OwnedDocument", "finished $target progress=${v.progress}")
            original.onPageFinished(v, target)
            // Native notice routing may reopen the same owned path. The actual
            // document token, not an earlier URL callback, proves fixture readiness.
            v.evaluateJavascript("window.__ownedFixtureToken === '$fixtureToken' && document.documentElement.dataset.appStarted === 'true'") { ready ->
                if (ready == "true") completed.countDown()
            }
        }
        override fun shouldOverrideUrlLoading(v: WebView, request: WebResourceRequest) = original.shouldOverrideUrlLoading(v, request)
    }
    view.loadUrl(fixtureUrl)
    return completed
}

/** Chromium may discard an evaluateJavascript callback across navigation. Retry
 * the owned fixture probe within one deadline; never treat no callback as a value. */
internal fun readOwnedJavascript(view: WebView, code: String): String {
    val instrumentation = androidx.test.platform.app.InstrumentationRegistry.getInstrumentation()
    val deadline = android.os.SystemClock.elapsedRealtime() + 5000
    var attempts = 0
    while (android.os.SystemClock.elapsedRealtime() < deadline) {
        val done = java.util.concurrent.CountDownLatch(1)
        val value = java.util.concurrent.atomic.AtomicReference<String>()
        instrumentation.runOnMainSync { view.evaluateJavascript(code) { value.set(it); done.countDown() } }
        if (done.await(250, java.util.concurrent.TimeUnit.MILLISECONDS)) return value.get()
        attempts++
    }
    var details = ""
    instrumentation.runOnMainSync { details = "url=${view.url}; progress=${view.progress}; shown=${view.isShown}; attached=${view.isAttachedToWindow}; attempts=$attempts" }
    throw AssertionError("Owned fixture JavaScript did not answer within5s: $details")
}
