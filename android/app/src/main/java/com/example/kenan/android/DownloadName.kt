package com.example.kenan.android

import androidx.webkit.URLUtilCompat

fun downloadName(disposition: String): Outcome<String> = try {
    val name = URLUtilCompat.getFilenameFromContentDisposition(disposition)
    require(name != null && name.isNotBlank() && name.length <= 160 && name !in setOf(".", ".."))
    require(name.none { it == '/' || it == '\\' || it.isISOControl() })
    Outcome.Ok(name)
} catch (_: Exception) {
    Outcome.Err("invalid_input", "Download filename is missing or invalid")
}
