package com.example.kenan.android

/** A web claim alone cannot suppress a phone notification: native lifecycle and owner must agree. */
data class ThreadPresence(val accountId: String, val domainId: String, val conversationId: String?, val visible: Boolean) {
    fun isViewing(account: String, domain: String, conversation: String?, resumed: Boolean, chatVisible: Boolean, interactive: Boolean, locked: Boolean): Boolean =
        resumed && chatVisible && interactive && !locked && visible && conversation != null &&
            accountId == account && domainId == domain && conversationId == conversation
}
object NativeThreadPresence {
    @Volatile var thread: ThreadPresence? = null
    @Volatile var resumed = false
    @Volatile var chatVisible = false
    private data class WindowState(var thread: ThreadPresence? = null, var resumed: Boolean = false, var chat: Boolean = false)
    private val windows = java.util.WeakHashMap<Any, WindowState>()
    @Synchronized fun record(window: Any, value: ThreadPresence?) { windows.getOrPut(window) { WindowState() }.thread = value; thread = value }
    @Synchronized fun current(window: Any): ThreadPresence? = windows[window]?.thread
    @Synchronized fun lifecycle(window: Any, active: Boolean) { windows.getOrPut(window) { WindowState() }.resumed = active; resumed = windows.values.any { it.resumed } }
    @Synchronized fun showChat(window: Any, visible: Boolean) { windows.getOrPut(window) { WindowState() }.chat = visible; chatVisible = visible }
    @Synchronized fun remove(window: Any) { windows.remove(window); resumed = windows.values.any { it.resumed }; thread = null }
    @Synchronized fun isViewing(account: String, domain: String, conversation: String?, interactive: Boolean, locked: Boolean): Boolean =
        windows.values.any { it.thread?.isViewing(account, domain, conversation, it.resumed, it.chat, interactive, locked) == true } ||
            (windows.isEmpty() && thread?.isViewing(account, domain, conversation, resumed, chatVisible, interactive, locked) == true)
    @Synchronized fun clear() { thread = null; windows.values.forEach { it.thread = null } }
}
