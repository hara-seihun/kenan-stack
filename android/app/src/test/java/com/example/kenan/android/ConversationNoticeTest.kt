package com.example.kenan.android

import org.junit.Assert.*
import org.junit.Test

class ConversationNoticeTest {
    @Test fun stableConversationIdentityIsScopedAndUnambiguous() {
        assertEquals(conversationShortcutId("a", "b", "c"), conversationShortcutId("a", "b", "c"))
        assertNotEquals(conversationShortcutId("a", "bc", "d"), conversationShortcutId("ab", "c", "d"))
        assertNotEquals(conversationShortcutId("a", "b", "c"), conversationShortcutId("a", "b", "other"))
    }
    @Test fun pausedMainWindowDoesNotHideResumedBubble() {
        NativeThreadPresence.clear()
        val main = Any(); val bubble = Any()
        NativeThreadPresence.record(main, ThreadPresence("a", "d", "other", true))
        NativeThreadPresence.lifecycle(main, true); NativeThreadPresence.showChat(main, true)
        NativeThreadPresence.record(bubble, ThreadPresence("a", "d", "chat", true))
        NativeThreadPresence.lifecycle(bubble, true); NativeThreadPresence.showChat(bubble, true)
        NativeThreadPresence.lifecycle(main, false)
        assertTrue(NativeThreadPresence.isViewing("a", "d", "chat", true, false))
        assertFalse(NativeThreadPresence.isViewing("a", "d", "other", true, false))
        NativeThreadPresence.lifecycle(main, true)
        NativeThreadPresence.lifecycle(bubble, false)
        assertFalse(NativeThreadPresence.isViewing("a", "d", "chat", true, false))
        assertTrue(NativeThreadPresence.isViewing("a", "d", "other", true, false))
        NativeThreadPresence.remove(main); NativeThreadPresence.remove(bubble)
    }
}
