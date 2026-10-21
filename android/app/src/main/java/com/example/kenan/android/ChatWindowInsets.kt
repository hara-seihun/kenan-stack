package com.example.kenan.android

import android.view.View
import androidx.core.graphics.Insets
import androidx.core.view.ViewCompat
import androidx.core.view.WindowInsetsAnimationCompat
import androidx.core.view.WindowInsetsCompat

/** The native container owns resizing; WebView still receives each zeroed inset update. */
fun fitChatInsets(root: View) {
    val handled = WindowInsetsCompat.Type.systemBars() or WindowInsetsCompat.Type.displayCutout() or WindowInsetsCompat.Type.ime()
    var animatingKeyboard = false
    fun apply(insets: WindowInsetsCompat) {
        val safe = insets.getInsets(handled)
        if (root.paddingLeft != safe.left || root.paddingTop != safe.top || root.paddingRight != safe.right || root.paddingBottom != safe.bottom)
            root.setPadding(safe.left, safe.top, safe.right, safe.bottom)
    }
    fun remaining(insets: WindowInsetsCompat) = WindowInsetsCompat.Builder(insets).setInsets(handled, Insets.NONE).build()
    ViewCompat.setOnApplyWindowInsetsListener(root) { _, insets ->
        if (!animatingKeyboard) apply(insets)
        // CONSUMED stops WebView's viewport updates altogether. Zero only what we applied.
        remaining(insets)
    }
    ViewCompat.setWindowInsetsAnimationCallback(root, object : WindowInsetsAnimationCompat.Callback(DISPATCH_MODE_CONTINUE_ON_SUBTREE) {
        override fun onPrepare(animation: WindowInsetsAnimationCompat) {
            if (animation.typeMask and WindowInsetsCompat.Type.ime() != 0) animatingKeyboard = true
        }
        override fun onProgress(insets: WindowInsetsCompat, runningAnimations: MutableList<WindowInsetsAnimationCompat>): WindowInsetsCompat {
            apply(insets)
            return remaining(insets)
        }
        override fun onEnd(animation: WindowInsetsAnimationCompat) {
            if (animation.typeMask and WindowInsetsCompat.Type.ime() != 0) {
                animatingKeyboard = false
                ViewCompat.getRootWindowInsets(root)?.let(::apply)
            }
        }
    })
    ViewCompat.requestApplyInsets(root)
}
