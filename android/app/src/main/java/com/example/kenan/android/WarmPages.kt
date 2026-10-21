package com.example.kenan.android

import android.content.ComponentCallbacks2
import android.content.Context
import android.content.MutableContextWrapper
import android.content.res.Configuration
import android.view.ViewGroup
import android.webkit.WebView

/**
 * Detached rendered pages that survive Activity destruction within this process: the signed-in
 * main page (closing and reopening the app) and at most two conversation bubbles.
 */
internal object WarmPages {
    sealed interface Target {
        /** The main app document; it routes between conversations itself. */
        data object Main : Target
        /** A bubble pinned to one conversation. */
        data class Thread(val account: String, val domain: String, val conversation: String) : Target
    }
    data class Key(val origin: String, val session: String, val target: Target)
    class Bridge : androidx.webkit.WebViewCompat.WebMessageListener {
        var listener: androidx.webkit.WebViewCompat.WebMessageListener? = null
        var installed = false
        override fun onPostMessage(view: WebView, message: androidx.webkit.WebMessageCompat, sourceOrigin: android.net.Uri, isMainFrame: Boolean, replyProxy: androidx.webkit.JavaScriptReplyProxy) {
            listener?.onPostMessage(view, message, sourceOrigin, isMainFrame, replyProxy)
        }
    }
    data class Page(val view: WebView, val presence: ThreadPresence?, val bridge: Bridge)
    private const val THREAD_PAGES = 2
    private val pages = LinkedHashMap<Key, Page>()
    private var registered = false
    fun register(context: Context) {
        if (registered) return
        registered = true
        context.applicationContext.registerComponentCallbacks(object : ComponentCallbacks2 {
            override fun onConfigurationChanged(configuration: Configuration) = Unit
            override fun onLowMemory() = clear()
            override fun onTrimMemory(level: Int) {
                // UI_HIDDEN and BACKGROUND arrive on every app close or bubble collapse; retaining across them is the point.
                if (level == ComponentCallbacks2.TRIM_MEMORY_RUNNING_CRITICAL || level >= ComponentCallbacks2.TRIM_MEMORY_MODERATE) clear()
            }
        })
    }
    private fun stale(cached: Key, wanted: Key): Boolean {
        if (cached.origin != wanted.origin || cached.session != wanted.session) return true
        val a = cached.target; val b = wanted.target
        return a is Target.Thread && b is Target.Thread && (a.account != b.account || a.domain != b.domain)
    }
    fun take(key: Key): Page? {
        pages.keys.filter { stale(it, key) }.toList().forEach { pages.remove(it)?.view?.destroy() }
        return pages.remove(key)
    }
    fun put(key: Key, page: Page) {
        (page.view.parent as? ViewGroup)?.removeView(page.view)
        page.view.onPause()
        // Detached pages still receive renderer-death callbacks. Never hand out a dead page.
        page.view.webViewClient = object : android.webkit.WebViewClient() {
            override fun onRenderProcessGone(view: WebView, detail: android.webkit.RenderProcessGoneDetail): Boolean {
                pages.entries.removeAll { it.value.view === view }
                view.destroy()
                return true
            }
        }
        (page.view.context as MutableContextWrapper).baseContext = page.view.context.applicationContext
        pages.remove(key)?.view?.destroy()
        pages[key] = page
        while (pages.keys.count { it.target is Target.Thread } > THREAD_PAGES)
            pages.remove(pages.keys.first { it.target is Target.Thread })?.view?.destroy()
    }
    fun clear() { pages.values.forEach { it.view.destroy() }; pages.clear() }
}
