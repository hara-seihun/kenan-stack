package com.example.kenan.android

import android.app.NotificationManager
import android.content.Context
import android.content.Intent
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.graphics.PixelFormat
import android.graphics.drawable.GradientDrawable
import android.net.Uri
import android.provider.Settings
import android.view.Gravity
import android.view.MotionEvent
import android.view.View
import android.view.ViewConfiguration
import android.view.WindowManager
import android.widget.ImageView
import org.json.JSONObject

/** Only the head is an overlay. The editor is a normal Activity, accessible to keyboards/dictation. */
internal object ChatHeads {
    private data class Target(val owner: String, val domain: String, val conversation: String, val title: String)
    private var view: ImageView? = null
    private var windowManager: WindowManager? = null
    private var shown: Target? = null
    private var dismissTarget: android.widget.TextView? = null
    private val previewHandler = android.os.Handler(android.os.Looper.getMainLooper())
    private val dismissPreview = Runnable { clearPreview() }
    private var previewView: android.widget.TextView? = null
    private var previewAt = Long.MIN_VALUE
    private var snap: android.animation.ValueAnimator? = null
    internal data class Haptic(val kind: Int, val accepted: Boolean)
    internal var lastHaptic: Haptic? = null
        private set
    private fun haptic(view: View, kind: Int) {
        lastHaptic = Haptic(kind, view.performHapticFeedback(kind))
        android.util.Log.i("KenanBubble", "haptic kind=$kind accepted=${lastHaptic!!.accepted}")
    }
    private val foreground = java.util.WeakHashMap<Any, Boolean>()
    private fun prefs(context: Context) = context.getSharedPreferences("kenan-next-device", Context.MODE_PRIVATE)
    fun enabled(context: Context) = prefs(context).getBoolean("chatHeadEnabled", true)
    fun available(context: Context) = enabled(context) && Settings.canDrawOverlays(context)
    private fun target(context: Context): Target? {
        val p = prefs(context)
        val raw = p.getString("chatHeadTarget", null) ?: return null
        val value = try { JSONObject(raw) } catch (_: Exception) { return null }
        val target = Target(value.optString("owner"), value.optString("domain"), value.optString("conversation"), value.optString("title", "Kenaznia"))
        return target.takeIf { it.owner == p.getString("ownerId", null) && it.domain == p.getString("domainId", null) && it.conversation.isNotBlank() && p.getString("sessionEpoch", null) != null }
    }
    fun offer(context: Context, owner: String, domain: String, conversation: String, title: String, select: Boolean = false) {
        val p = prefs(context)
        if (owner != p.getString("ownerId", null) || domain != p.getString("domainId", null) || conversation.isBlank()) return
        val previous = target(context)
        // A message in a different thread must not hijack the user's pinned conversation.
        if (select || previous == null || previous.conversation == conversation) {
            p.edit().putString("chatHeadTarget", JSONObject().put("owner", owner).put("domain", domain).put("conversation", conversation).put("title", title).toString()).apply()
        }
        restore(context)
    }
    fun preview(context: Context, owner: String, domain: String, conversation: String, body: String, createdAt: Long) {
        if (android.os.Looper.myLooper() != android.os.Looper.getMainLooper()) {
            previewHandler.post { preview(context.applicationContext, owner, domain, conversation, body, createdAt) }; return
        }
        val current = shown ?: return
        val head = view ?: return
        if (current.owner != owner || current.domain != domain || current.conversation != conversation || target(context) != current ||
            !available(context) || foreground.isNotEmpty() || body.isBlank() || createdAt < previewAt) return
        // offer() creates the head in the same delivery callback. Its first
        // WindowManager traversal has not attached/measured it yet.
        if (!head.isAttachedToWindow || head.width == 0) {
            head.post { if (view === head) preview(context, owner, domain, conversation, body, createdAt) }; return
        }
        previewAt = createdAt
        val existing = previewView
        if (existing?.isAttachedToWindow == true) {
            existing.text = body
            previewHandler.removeCallbacks(dismissPreview); previewHandler.postDelayed(dismissPreview, 6000)
            return
        }
        clearPreview()
        val metrics = context.resources.displayMetrics
        fun dp(n: Int) = (n * metrics.density).toInt()
        val location = IntArray(2); head.getLocationOnScreen(location)
        val width = minOf(dp(240), metrics.widthPixels - head.width - dp(16)).coerceAtLeast(dp(80))
        val text = android.widget.TextView(context.applicationContext).apply {
            this.text = body; setTextColor(android.graphics.Color.WHITE); textSize = 15f
            setPadding(dp(14), dp(10), dp(14), dp(10)); maxLines = 3; ellipsize = android.text.TextUtils.TruncateAt.END
            background = GradientDrawable().apply { setColor(0xff263746.toInt()); cornerRadius = dp(18).toFloat() }
            contentDescription = "Chat message preview"; elevation = dp(4).toFloat()
            setOnClickListener { clearPreview(); head.performClick() }
        }
        val params = WindowManager.LayoutParams(width, WindowManager.LayoutParams.WRAP_CONTENT, WindowManager.LayoutParams.TYPE_APPLICATION_OVERLAY,
            WindowManager.LayoutParams.FLAG_NOT_FOCUSABLE or WindowManager.LayoutParams.FLAG_NOT_TOUCH_MODAL, PixelFormat.TRANSLUCENT).apply {
            gravity = Gravity.TOP or Gravity.LEFT
            x = (if (location[0] > metrics.widthPixels / 2) location[0] - width - dp(8) else location[0] + head.width + dp(8)).coerceIn(0, (metrics.widthPixels - width).coerceAtLeast(0))
            y = location[1].coerceIn(0, (metrics.heightPixels - dp(100)).coerceAtLeast(0))
        }
        try { windowManager?.addView(text, params); previewView = text; previewHandler.postDelayed(dismissPreview, 6000) }
        catch (_: SecurityException) { clearPreview() } // The durable notification remains available if overlay authority changes.
        catch (_: WindowManager.BadTokenException) { clearPreview() } // Android also reports revoked overlay authority as a bad window token.
    }
    fun clearPreview(owner: String? = null, domain: String? = null, conversation: String? = null) {
        if (android.os.Looper.myLooper() != android.os.Looper.getMainLooper()) {
            previewHandler.post { clearPreview(owner, domain, conversation) }; return
        }
        if (owner != null && (shown?.owner != owner || shown?.domain != domain || shown?.conversation != conversation)) return
        previewHandler.removeCallbacks(dismissPreview)
        previewView?.let { if (it.isAttachedToWindow) windowManager?.removeViewImmediate(it) }; previewView = null
    }
    fun foreground(context: Context, window: Any, visible: Boolean) {
        if (visible) foreground[window] = true else foreground.remove(window)
        restore(context)
    }
    fun dismiss(context: Context) { prefs(context).edit().putBoolean("chatHeadEnabled", false).apply(); close() }
    fun forget(context: Context) { prefs(context).edit().remove("chatHeadTarget").apply(); close() }
    fun restore(context: Context) {
        if (android.os.Looper.myLooper() != android.os.Looper.getMainLooper()) {
            android.os.Handler(android.os.Looper.getMainLooper()).post { restore(context.applicationContext) }; return
        }
        val app = context.applicationContext
        val target = target(app)
        if (target == null || !available(app) || foreground.isNotEmpty()) { close(); return }
        if (view != null && shown == target) return
        close()
        val metrics = app.resources.displayMetrics
        fun dp(n: Int) = (n * metrics.density).toInt()
        val size = dp(64)
        val windows = app.getSystemService(WindowManager::class.java)
        val p = prefs(app)
        val params = WindowManager.LayoutParams(size, size, WindowManager.LayoutParams.TYPE_APPLICATION_OVERLAY,
            WindowManager.LayoutParams.FLAG_NOT_FOCUSABLE or WindowManager.LayoutParams.FLAG_NOT_TOUCH_MODAL,
            PixelFormat.TRANSLUCENT).apply {
            gravity = Gravity.TOP or Gravity.LEFT
            x = p.getInt("chatHeadX", metrics.widthPixels - size).coerceIn(0, (metrics.widthPixels - size).coerceAtLeast(0))
            y = p.getInt("chatHeadY", dp(120)).coerceIn(0, (metrics.heightPixels - size).coerceAtLeast(0))
        }
        val source = BitmapFactory.decodeResource(app.resources, R.drawable.kenaznia_face)
        val inset = source.width / 6
        val face = Bitmap.createBitmap(source, inset, inset, source.width - inset * 2, source.height - inset * 2)
        val head = ImageView(app).apply {
            setImageBitmap(face); scaleType = ImageView.ScaleType.FIT_CENTER
            background = GradientDrawable().apply { shape = GradientDrawable.OVAL; setColor(android.graphics.Color.BLACK) }
            clipToOutline = true; elevation = dp(4).toFloat()
            contentDescription = "Open floating chat"; isClickable = true; isFocusable = true
            setOnClickListener {
                val current = target(app) ?: return@setOnClickListener
                val location = IntArray(2); getLocationOnScreen(location)
                app.startActivity(destination(app, current.owner, current.domain, current.conversation)
                    .putExtra("headX", location[0]).putExtra("headY", location[1])
                    .putExtra("bubbleTapAt", android.os.SystemClock.uptimeMillis()))
            }
            setOnLongClickListener { dismiss(app); android.widget.Toast.makeText(app, "Floating chat hidden", android.widget.Toast.LENGTH_SHORT).show(); true }
        }
        var downX = 0f; var downY = 0f; var startX = 0; var startY = 0; var dragging = false
        var startScreenX = 0; var startScreenY = 0
        var overDismiss = false
        val slop = ViewConfiguration.get(app).scaledTouchSlop
        fun hideDismiss() {
            dismissTarget?.let { target -> target.animate().cancel(); if (target.isAttachedToWindow) windows.removeViewImmediate(target) }
            dismissTarget = null; overDismiss = false
        }
        fun showDismiss() {
            if (dismissTarget != null) return
            val target = android.widget.TextView(app).apply {
                text = "×"; textSize = 38f; gravity = Gravity.CENTER; setTextColor(android.graphics.Color.WHITE)
                contentDescription = "Dismiss floating chat"
                background = GradientDrawable().apply { shape = GradientDrawable.OVAL; setColor(0xE6222222.toInt()); setStroke(dp(2), 0xFF888888.toInt()) }
                alpha = 0f; scaleX = .7f; scaleY = .7f
            }
            val targetParams = WindowManager.LayoutParams(dp(80), dp(80), WindowManager.LayoutParams.TYPE_APPLICATION_OVERLAY,
                WindowManager.LayoutParams.FLAG_NOT_FOCUSABLE,
                PixelFormat.TRANSLUCENT).apply { gravity = Gravity.TOP or Gravity.LEFT; x = (metrics.widthPixels - dp(80))/2; y = metrics.heightPixels - dp(160) }
            try { windows.addView(target, targetParams); dismissTarget = target; target.animate().alpha(1f).scaleX(1f).scaleY(1f).setDuration(140).start() }
            catch (_: SecurityException) { hideDismiss() }
        }
        fun trackDismiss(event: MotionEvent) {
            val target = dismissTarget ?: return
            if (target.width == 0 || target.height == 0) return
            val location = IntArray(2); target.getLocationOnScreen(location)
            // Window relayout is asynchronous; the release must use this pointer, not the last drawn head.
            val headX = startScreenX + event.rawX - downX + size / 2
            val headY = startScreenY + event.rawY - downY + size / 2
            val inside = kotlin.math.hypot(headX-location[0]-target.width/2, headY-location[1]-target.height/2) < dp(60)
            if (inside == overDismiss) return
            overDismiss = inside
            if (inside) haptic(head, android.view.HapticFeedbackConstants.LONG_PRESS)
            target.background = GradientDrawable().apply { shape = GradientDrawable.OVAL; setColor(if (inside) 0xFFE13A4B.toInt() else 0xE6222222.toInt()); setStroke(dp(2), android.graphics.Color.WHITE) }
            target.animate().scaleX(if(inside) 1.2f else 1f).scaleY(if(inside) 1.2f else 1f).setDuration(100).start()
        }
        fun snapToEdge() {
            val edge = if (params.x + size / 2 < metrics.widthPixels / 2) 0 else (metrics.widthPixels - size).coerceAtLeast(0)
            p.edit().putInt("chatHeadX", edge).putInt("chatHeadY", params.y).apply()
            snap?.cancel()
            snap = android.animation.ValueAnimator.ofInt(params.x, edge).apply {
                duration = 180; interpolator = android.view.animation.DecelerateInterpolator()
                addUpdateListener { if (view === head && head.isAttachedToWindow) { params.x = it.animatedValue as Int; windows.updateViewLayout(head, params) } }
                start()
            }
        }
        head.setOnTouchListener { _, event ->
            when (event.actionMasked) {
                MotionEvent.ACTION_DOWN -> {
                    clearPreview(); snap?.cancel(); downX = event.rawX; downY = event.rawY; startX = params.x; startY = params.y
                    val location=IntArray(2); head.getLocationOnScreen(location);startScreenX=location[0];startScreenY=location[1]
                    dragging = false; false
                }
                MotionEvent.ACTION_MOVE -> {
                    if (kotlin.math.hypot(event.rawX - downX, event.rawY - downY) > slop) { dragging = true; head.cancelLongPress(); showDismiss() }
                    if (dragging) {
                        params.x = (startX + event.rawX - downX).toInt().coerceIn(0, (metrics.widthPixels - size).coerceAtLeast(0))
                        params.y = (startY + event.rawY - downY).toInt().coerceIn(0, (metrics.heightPixels - size).coerceAtLeast(0))
                        if (head.isAttachedToWindow) windows.updateViewLayout(head, params)
                        trackDismiss(event)
                    }; dragging
                }
                MotionEvent.ACTION_UP, MotionEvent.ACTION_CANCEL -> {
                    if (dragging) {
                        trackDismiss(event)
                        val dismiss = event.actionMasked == MotionEvent.ACTION_UP && overDismiss
                        hideDismiss()
                        if (dismiss) {
                            p.edit().putBoolean("chatHeadEnabled", false).apply()
                            haptic(head, android.view.HapticFeedbackConstants.CONFIRM)
                            head.animate().scaleX(.1f).scaleY(.1f).alpha(0f).setDuration(140).withEndAction { close() }.start()
                        } else snapToEdge()
                    }; dragging
                }
                else -> false
            }
        }
        try { windows.addView(head, params); view = head; shown = target; windowManager = windows }
        catch (_: SecurityException) { close() } // Permission can be revoked while the app is open.
        catch (_: WindowManager.BadTokenException) { close() }
    }
    fun destination(context: Context, owner: String, domain: String, conversation: String): Intent =
        Intent(context, BubbleActivity::class.java).setAction("open-notice")
            .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_SINGLE_TOP or Intent.FLAG_ACTIVITY_NO_ANIMATION)
            .putExtra("headX", prefs(context).getInt("chatHeadX", context.resources.displayMetrics.widthPixels - (64 * context.resources.displayMetrics.density).toInt()))
            .putExtra("headY", prefs(context).getInt("chatHeadY", (120 * context.resources.displayMetrics.density).toInt()))
            .putExtra("accountId", owner).putExtra("noticeDomainId", domain).putExtra("conversationId", conversation)
            .setData(Uri.parse("kenan-next://floating/${conversationShortcutId(owner, domain, conversation)}"))
    fun retireSystemBubbles(context: Context) {
        if (android.os.Build.VERSION.SDK_INT < 29) return
        val manager = context.getSystemService(NotificationManager::class.java)
        manager.activeNotifications.filter { it.notification.bubbleMetadata != null }.forEach {
            // Replace the notification in place without SystemUI's separately badged bubble.
            manager.notify(it.tag, it.id, android.app.Notification.Builder.recoverBuilder(context, it.notification)
                .setBubbleMetadata(null).setOnlyAlertOnce(true).build())
        }
    }
    fun close() {
        clearPreview(); previewAt = Long.MIN_VALUE
        snap?.cancel(); snap = null
        dismissTarget?.let { target -> target.animate().cancel(); if(target.isAttachedToWindow) windowManager?.removeViewImmediate(target) }; dismissTarget = null
        val current = view; view = null; shown = null
        current?.animate()?.withEndAction(null)?.cancel()
        if (current?.isAttachedToWindow == true) windowManager?.removeViewImmediate(current)
        windowManager = null
    }
}
