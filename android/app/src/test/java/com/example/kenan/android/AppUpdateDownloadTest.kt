package com.example.kenan.android

import org.junit.Assert.*
import org.junit.Test

class AppUpdateDownloadTest {
    @Test fun publicAppLinksUseTheirOwnNativeChannel() {
        val beta = "https://beta.kenan.example.com"
        val production = "https://kenan.example.com"
        for (origin in listOf(beta, production)) {
            assertTrue(isAppUpdateDownload("$origin/app.apk", origin))
            assertTrue(isAppUpdateDownload("$origin/api/android/apk/${"a".repeat(64)}.apk", origin))
        }
        assertFalse(isAppUpdateDownload("$production/app.apk", beta))
        assertFalse(isAppUpdateDownload("$beta/app.apk", production))
    }
    @Test fun ordinaryFilesAndAmbiguousUrlsRemainDownloads() {
        val origin = "https://beta.kenan.example.com"
        for (path in listOf("/app.apk?url=foreign", "/app.apk#fragment", "/api/artifacts/one/content", "/files/app.apk", "/api/android/apk/latest.apk", "/%61pp.apk")) {
            assertFalse(path, isAppUpdateDownload(origin + path, origin))
        }
        assertFalse(isAppUpdateDownload("https://someone@beta.kenan.example.com/app.apk", origin))
        assertFalse(isAppUpdateDownload("malformed", origin))
    }
}
