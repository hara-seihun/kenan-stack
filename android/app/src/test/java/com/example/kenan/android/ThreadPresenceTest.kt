package com.example.kenan.android

import org.junit.Assert.*
import org.junit.Test

class ThreadPresenceTest {
    private val presence = ThreadPresence("account", "domain", "manager", true)
    @Test fun onlyExactOpenThreadSuppresses() {
        assertTrue(presence.isViewing("account", "domain", "manager", true, true, true, false))
        assertFalse(presence.isViewing("account", "domain", "worker", true, true, true, false))
        assertFalse(presence.isViewing("other", "domain", "manager", true, true, true, false))
        assertFalse(presence.isViewing("account", "other", "manager", true, true, true, false))
        assertFalse(presence.isViewing("account", "domain", null, true, true, true, false))
    }
    @Test fun setupBackgroundScreenOffAndLockNeverSuppress() {
        assertFalse(presence.isViewing("account", "domain", "manager", true, false, true, false))
        assertFalse(presence.isViewing("account", "domain", "manager", false, true, true, false))
        assertFalse(presence.isViewing("account", "domain", "manager", true, true, false, false))
        assertFalse(presence.isViewing("account", "domain", "manager", true, true, true, true))
        assertFalse(presence.copy(visible=false).isViewing("account", "domain", "manager", true, true, true, false))
    }
}
