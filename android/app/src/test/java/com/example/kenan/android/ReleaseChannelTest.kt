package com.example.kenan.android

import org.junit.Assert.*
import org.junit.Test

class ReleaseChannelTest {
    @Test fun packageOriginAndVisibleNameStayOnTheSameChannel() {
        if (BuildConfig.RELEASE_CHANNEL == "production") {
            assertEquals("com.example.kenan.piremote.kenan", BuildConfig.APPLICATION_ID)
            assertEquals("https://kenan.example.com", BETA_ORIGIN)
            assertEquals("Kenan", APP_LABEL)
            assertTrue(BuildConfig.VERSION_CODE >= 11654)
        } else {
            assertEquals("beta", BuildConfig.RELEASE_CHANNEL)
            assertEquals("com.example.kenan.android", BuildConfig.APPLICATION_ID)
            assertEquals("https://beta.kenan.example.com", BETA_ORIGIN)
            assertEquals("Kenan Beta", APP_LABEL)
        }
    }
}
