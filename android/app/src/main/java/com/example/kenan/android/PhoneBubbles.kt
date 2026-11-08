package com.example.kenan.android

import android.animation.ValueAnimator
import android.content.Context
import android.graphics.Canvas
import android.graphics.Paint
import android.graphics.PixelFormat
import android.graphics.Typeface
import android.graphics.drawable.GradientDrawable
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.util.TypedValue
import android.view.Gravity
import android.view.View
import android.view.WindowInsets
import android.view.WindowManager
import android.view.accessibility.AccessibilityWindowInfo
import android.widget.LinearLayout
import android.widget.TextView

/**
 * Bubbles Kenan shows over whatever app is open while it uses the phone, in the accessibility service's own overlay
 * windows (no overlay permission): an agent's instruction ("say") that stays until she taps it or the session ends, with
 * an optional pulsing ring on the spot to tap, and a short "done" bubble when the session ends. They are hidden while a
 * screenshot is taken and left out of ui, so the agent sees only the phone. Main thread.
 */
object PhoneBubbles {
    enum class Place { Top, Bottom }
    private const val DONE_MS = 6_000L
    private const val HIDE_SETTLE_MS = 120L
    private val main = Handler(Looper.getMainLooper())
    private var windows: WindowManager? = null
    private var bubble: View? = null
    private var ring: View? = null
    private var hidden = false
    private val expire = Runnable { clear() }

    /** The instruction she can still see, null once she closed it or none was given. */
    var said: String? = null; private set

    private fun dp(context: Context, v: Int) = TypedValue.applyDimension(TypedValue.COMPLEX_UNIT_DIP, v.toFloat(), context.resources.displayMetrics).toInt()

    /** Status bar and navigation bar heights, so a bubble sits clear of both. */
    private fun bars(service: PhoneControlService): Pair<Int, Int> {
        if (Build.VERSION.SDK_INT >= 30) {
            val insets = service.getSystemService(WindowManager::class.java).currentWindowMetrics.windowInsets
                .getInsetsIgnoringVisibility(WindowInsets.Type.systemBars() or WindowInsets.Type.displayCutout())
            return insets.top to insets.bottom
        }
        val res = service.resources
        fun dimen(name: String) = res.getIdentifier(name, "dimen", "android").takeIf { it != 0 }?.let(res::getDimensionPixelSize) ?: 0
        return dimen("status_bar_height") to dimen("navigation_bar_height")
    }

    private fun params(width: Int, height: Int, touchable: Boolean) = WindowManager.LayoutParams(width, height, WindowManager.LayoutParams.TYPE_ACCESSIBILITY_OVERLAY,
        WindowManager.LayoutParams.FLAG_NOT_FOCUSABLE or WindowManager.LayoutParams.FLAG_NOT_TOUCH_MODAL or WindowManager.LayoutParams.FLAG_LAYOUT_IN_SCREEN or
            WindowManager.LayoutParams.FLAG_LAYOUT_NO_LIMITS or (if (touchable) 0 else WindowManager.LayoutParams.FLAG_NOT_TOUCHABLE),
        PixelFormat.TRANSLUCENT).apply {
        if (Build.VERSION.SDK_INT >= 30) layoutInDisplayCutoutMode = WindowManager.LayoutParams.LAYOUT_IN_DISPLAY_CUTOUT_MODE_ALWAYS
        else if (Build.VERSION.SDK_INT >= 28) layoutInDisplayCutoutMode = WindowManager.LayoutParams.LAYOUT_IN_DISPLAY_CUTOUT_MODE_SHORT_EDGES
        title = "Kenan bubble"
    }

    private fun card(service: PhoneControlService, fill: Int, stroke: Int, heading: String?, message: String, footer: String?): View {
        val text = { size: Float, color: Int -> TextView(service).apply { textSize = size; setTextColor(color) } }
        return LinearLayout(service).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(dp(service, 18), dp(service, 14), dp(service, 18), dp(service, 14))
            background = GradientDrawable().apply { cornerRadius = dp(service, 18).toFloat(); setColor(fill); setStroke(dp(service, 2), stroke) }
            elevation = dp(service, 8).toFloat()
            heading?.let { addView(text(15f, stroke).apply { this.text = it; setTypeface(typeface, Typeface.BOLD) }) }
            addView(text(19f, 0xFFF3F3F3.toInt()).apply { this.text = message; setLineSpacing(0f, 1.15f); if (heading != null) setPadding(0, dp(service, 4), 0, 0) })
            footer?.let { addView(text(15f, 0xFFA1A1A1.toInt()).apply { this.text = it; setPadding(0, dp(service, 6), 0, 0) }) }
            contentDescription = listOfNotNull(heading, message, footer).joinToString(". ")
            isClickable = true
            setOnClickListener { clear() }
        }
    }

    private fun showBubble(service: PhoneControlService, view: View, place: Place) {
        val wm = service.getSystemService(WindowManager::class.java)
        val size = service.screenSize()
        val (top, bottom) = bars(service)
        val width = minOf(size.width() - 2 * dp(service, 14), dp(service, 560))
        wm.addView(view.also { it.visibility = if (hidden) View.INVISIBLE else View.VISIBLE }, params(width, WindowManager.LayoutParams.WRAP_CONTENT, true).apply {
            gravity = Gravity.CENTER_HORIZONTAL or if (place == Place.Top) Gravity.TOP else Gravity.BOTTOM
            y = (if (place == Place.Top) top else bottom) + dp(service, 12)
        })
        windows = wm; bubble = view
    }

    /** Shows her an instruction, replacing any earlier one; point (screen pixels) gets a ring. */
    fun say(service: PhoneControlService, message: String, place: Place, point: Pair<Float, Float>?) {
        clear()
        showBubble(service, card(service, 0xFF151515.toInt(), 0xFF85B7E9.toInt(), "💬 Kenan", message, "Tap this bubble to close it"), place)
        said = message
        if (point != null) {
            val side = dp(service, 72)
            val view = Ring(service, dp(service, 4).toFloat())
            windows!!.addView(view.also { it.visibility = if (hidden) View.INVISIBLE else View.VISIBLE }, params(side, side, false).apply {
                gravity = Gravity.TOP or Gravity.START; x = point.first.toInt() - side / 2; y = point.second.toInt() - side / 2
            })
            ring = view
        }
    }

    /** A short bubble when the session ends; closes after a few seconds or when she taps it. */
    fun done(service: PhoneControlService, heading: String, message: String) {
        clear()
        showBubble(service, card(service, 0xFF17241B.toInt(), 0xFF6CC28A.toInt(), heading, message, null), Place.Top)
        main.postDelayed(expire, DONE_MS)
    }

    fun clear() {
        main.removeCallbacks(expire)
        val wm = windows
        for (view in listOfNotNull(bubble, ring)) if (view.isAttachedToWindow) wm!!.removeViewImmediate(view)
        bubble = null; ring = null; said = null; windows = null
    }

    /** Runs capture with the bubbles invisible; capture calls restore once the screenshot is taken (from any thread). */
    fun hiddenFor(capture: (restore: () -> Unit) -> Unit) {
        val views = listOfNotNull(bubble, ring)
        if (views.isEmpty()) { capture {}; return }
        hidden = true
        views.forEach { it.visibility = View.INVISIBLE }
        main.postDelayed({
            capture { main.post { hidden = false; listOfNotNull(bubble, ring).forEach { it.visibility = View.VISIBLE } } }
        }, HIDE_SETTLE_MS)
    }

    /** Whether a window is one of these bubbles (left out of ui). */
    fun isBubble(service: PhoneControlService, window: AccessibilityWindowInfo) =
        window.type == AccessibilityWindowInfo.TYPE_ACCESSIBILITY_OVERLAY && window.root?.packageName == service.packageName

    private class Ring(context: Context, private val stroke: Float) : View(context) {
        private val halo = Paint(Paint.ANTI_ALIAS_FLAG).apply { style = Paint.Style.STROKE; strokeWidth = stroke * 2.2f; color = 0xB3000000.toInt() }
        private val line = Paint(Paint.ANTI_ALIAS_FLAG).apply { style = Paint.Style.STROKE; strokeWidth = stroke; color = 0xFF85B7E9.toInt() }
        private val pulse = ValueAnimator.ofFloat(0.62f, 0.92f).apply {
            duration = 700; repeatMode = ValueAnimator.REVERSE; repeatCount = ValueAnimator.INFINITE
            addUpdateListener { invalidate() }
        }
        override fun onAttachedToWindow() { super.onAttachedToWindow(); pulse.start() }
        override fun onDetachedFromWindow() { pulse.cancel(); super.onDetachedFromWindow() }
        override fun onDraw(canvas: Canvas) {
            val r = (minOf(width, height) / 2f - stroke * 1.2f) * (pulse.animatedValue as Float)
            canvas.drawCircle(width / 2f, height / 2f, r, halo)
            canvas.drawCircle(width / 2f, height / 2f, r, line)
        }
    }
}
