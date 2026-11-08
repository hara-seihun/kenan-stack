package com.example.kenan.android

import android.app.Activity
import android.content.ClipData
import android.content.Intent
import android.net.Uri
import android.os.Build
import android.os.Bundle

/**
 * Kenan in Android's share sheet. It shows nothing: it hands what was shared, with the sender's read grant, to the
 * app's own window (opening it, or bringing it forward in its own task), which copies it and asks which chat it goes to.
 */
class ShareActivity : Activity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        val shared = intent
        val forward = Intent(this, MainActivity::class.java).setAction(SHARE_ACTION)
            .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TOP or Intent.FLAG_ACTIVITY_SINGLE_TOP or Intent.FLAG_GRANT_READ_URI_PERMISSION)
        shared.getStringExtra(Intent.EXTRA_SUBJECT)?.let { forward.putExtra(Intent.EXTRA_SUBJECT, it) }
        shared.getCharSequenceExtra(Intent.EXTRA_TEXT)?.let { forward.putExtra(Intent.EXTRA_TEXT, it) }
        val uris = streams(shared)
        if (uris.isNotEmpty()) forward.clipData = ClipData.newRawUri("Shared", uris.first()).apply { uris.drop(1).forEach { addItem(ClipData.Item(it)) } }
        // A sender that shared without granting read access makes the grant hand-over throw; the copy then reports
        // each file it can't read instead of the app closing.
        try { startActivity(forward) } catch (e: SecurityException) { startActivity(forward.setFlags(forward.flags and Intent.FLAG_GRANT_READ_URI_PERMISSION.inv())) }
        finish()
    }

    /** SEND carries one EXTRA_STREAM, SEND_MULTIPLE a list; senders also mirror them in clipData, which is read when the extra is absent. */
    private fun streams(intent: Intent): List<Uri> {
        @Suppress("DEPRECATION")
        val extra: List<Uri> = when (intent.action) {
            Intent.ACTION_SEND -> listOfNotNull(if (Build.VERSION.SDK_INT >= 33) intent.getParcelableExtra(Intent.EXTRA_STREAM, Uri::class.java) else intent.getParcelableExtra(Intent.EXTRA_STREAM))
            Intent.ACTION_SEND_MULTIPLE -> (if (Build.VERSION.SDK_INT >= 33) intent.getParcelableArrayListExtra(Intent.EXTRA_STREAM, Uri::class.java) else intent.getParcelableArrayListExtra(Intent.EXTRA_STREAM)) ?: emptyList()
            else -> emptyList()
        }
        val clip = intent.clipData
        return extra.ifEmpty { clip?.let { c -> (0 until c.itemCount).mapNotNull { c.getItemAt(it).uri } } ?: emptyList() }
    }
}
