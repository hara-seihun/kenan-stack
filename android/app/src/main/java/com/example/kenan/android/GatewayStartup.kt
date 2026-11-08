package com.example.kenan.android

import android.graphics.Color
import android.os.Handler
import android.os.Looper
import android.os.SystemClock
import android.view.Gravity
import android.view.View
import android.webkit.WebView
import android.widget.Button
import android.widget.FrameLayout
import android.widget.LinearLayout
import android.widget.TextView

internal const val gatewayReadyProbe = "Boolean(document.documentElement !== null && document.documentElement.dataset.appStarted === 'true')"

/** Native recovery stays usable even when the document or JavaScript cannot load. */
internal class GatewayStartup(private val web: WebView, private val retry: () -> Unit) : FrameLayout(web.context) {
    private val handler = Handler(Looper.getMainLooper())
    private val label = TextView(context).apply { setTextColor(Color.WHITE); textSize = 17f; gravity = Gravity.CENTER }
    private val retryButton = Button(context).apply { text = "Reload ${APP_LABEL}"; setOnClickListener { retry() } }
    private val panel = LinearLayout(context).apply {
        orientation = LinearLayout.VERTICAL; gravity = Gravity.CENTER; setPadding(32, 32, 32, 32)
        setBackgroundColor(Color.BLACK); addView(label); addView(retryButton)
    }
    private data class Outage(val since: Long, val failures: Int, val message: String, val document: String?)
    private sealed interface State {
        data object Ready : State
        data class Loading(val outage: Outage?) : State
        data class Retrying(val outage: Outage) : State
        data object Closed : State
    }
    private var state: State = State.Ready
    private var generation = 0
    private var inspection: Int? = null
    init { setBackgroundColor(Color.BLACK); addView(web, LayoutParams(-1, -1)); addView(panel, LayoutParams(-1, -1)); panel.visibility = View.GONE }
    private fun transition(next: State) {
        generation++; handler.removeCallbacksAndMessages(null); inspection = null; state = next
    }
    private fun outage(): Outage? = when (val current = state) {
        is State.Loading -> current.outage
        is State.Retrying -> current.outage
        State.Ready, State.Closed -> null
    }
    private fun showLoading(outage: Outage?) {
        val sustained = outage != null && outage.failures >= 2 && SystemClock.elapsedRealtime() - outage.since >= 8000
        // The document owns ordinary startup presentation. A second native
        // opening screen adds a flash before the web shell can paint. Mask
        // failed main-frame HTML only; expose a notice for a sustained outage.
        label.text = if (sustained) outage!!.message else ""
        retryButton.visibility = if (sustained) View.VISIBLE else View.GONE
        panel.visibility = if (outage == null) View.GONE else View.VISIBLE
        if (outage != null && !sustained && outage.failures >= 2) {
            val current = generation
            handler.postDelayed({ if (current == generation) showLoading(outage) }, maxOf(1L, 8000 - (SystemClock.elapsedRealtime() - outage.since)))
        }
    }
    fun loading(document: String? = web.url) {
        if (state == State.Closed) return
        // An HTTP error may precede its own onPageStarted callback, so that
        // document cannot claim success merely by starting. A different document
        // supersedes the failed navigation and owns its own readiness/watchdog.
        val current = state
        if (current is State.Retrying && current.outage.document == document) return
        beginLoading(outage()?.copy(document = document))
    }
    private fun beginLoading(outage: Outage?) {
        transition(State.Loading(outage)); showLoading(outage)
        val current = generation
        handler.postDelayed({ if (current == generation) failed("${APP_LABEL} is taking longer to open. Check your connection or try again.") }, 12000)
    }
    fun inspect() {
        // Chromium finishes failed navigations too. Only a new, nonfailed document may clear an outage.
        if (state !is State.Loading || inspection != null) return
        val current = generation
        inspection = current
        // A populated shell or an HTTP200 error page is not an interactive app.
        // Keep the native watchdog until the application owns its recovery.
        web.evaluateJavascript(gatewayReadyProbe) { populated ->
            if (inspection == current) inspection = null
            if (state is State.Loading && current == generation) {
                if (populated == "true") ready()
                else handler.postDelayed({ if (current == generation) inspect() }, 250)
            }
        }
    }
    fun ready() {
        if (state == State.Closed) return
        transition(State.Ready); panel.visibility = View.GONE
    }
    fun unreachable(reload: () -> Unit, message: String = "${APP_LABEL} is still reconnecting. Retrying automatically.", document: String? = web.url) {
        if (state == State.Closed) return
        val previous = outage()
        val outage = Outage(previous?.since ?: SystemClock.elapsedRealtime(), (previous?.failures ?: 0) + 1, message, document)
        transition(State.Retrying(outage)); showLoading(outage)
        val current = generation
        val delay = gatewayRetryDelay(outage.failures)
        handler.postDelayed({ if (current == generation) { beginLoading(outage); reload() } }, delay)
    }
    fun failed(message: String = "${APP_LABEL} is reopening automatically.") {
        unreachable(retry, message)
    }
    fun close() { transition(State.Closed) }
}
