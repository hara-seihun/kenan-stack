package com.example.kenan.android

/** Public app links open the installed channel's verified updater, even before login. */
fun isAppUpdateDownload(url: String, origin: String): Boolean = try {
    val uri = java.net.URI(url)
    val expected = java.net.URI(origin)
    uri.scheme == expected.scheme && uri.rawAuthority == expected.rawAuthority &&
        uri.rawUserInfo == null && uri.rawQuery == null && uri.rawFragment == null &&
        (uri.rawPath == "/app.apk" || Regex("/api/android/apk/[a-f0-9]{64}\\.apk").matches(uri.rawPath))
} catch (_: Exception) { false }
