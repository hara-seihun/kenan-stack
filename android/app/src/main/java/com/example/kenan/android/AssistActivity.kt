package com.example.kenan.android

import android.app.Activity
import android.content.Intent
import android.os.Bundle

/**
 * Kenan as Android's digital assistant (ACTION_ASSIST, ACTION_VOICE_COMMAND): long-press power, an assistant key or gesture
 * opens the app's own window in its own task, the way a notification does, instead of stacking a second copy of it.
 */
class AssistActivity : Activity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        startActivity(Intent(this, MainActivity::class.java).setAction(ASSIST_ACTION)
            .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TOP or Intent.FLAG_ACTIVITY_SINGLE_TOP))
        finish()
    }
    companion object { const val ASSIST_ACTION = "com.example.kenan.assist" }
}
