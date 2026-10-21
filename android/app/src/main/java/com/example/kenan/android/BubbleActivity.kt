package com.example.kenan.android

import android.animation.ValueAnimator
import android.content.Intent
import android.graphics.Color
import android.os.Build
import android.os.Bundle
import android.provider.Settings
import android.view.Gravity
import android.view.View
import android.view.WindowManager
import android.webkit.CookieManager
import android.widget.FrameLayout

/** A normal application window keeps the full editor accessible to independent dictation overlays. */
class BubbleActivity : MainActivity() {
    companion object { private var liveWindow: java.lang.ref.WeakReference<BubbleActivity>? = null }
    private enum class Motion { COLLAPSED, OPENING, EXPANDED, CLOSING }
    private var motion = Motion.COLLAPSED
    private var card: FrameLayout? = null
    private var scrim: View? = null
    private var pausedSession: String? = null
    private var requestingOverlay = false
    internal var firstFrameAt = 0L
    internal var expandedAt = 0L
    private fun session(): String? = CookieManager.getInstance().getCookie(BETA_ORIGIN)?.let(::sessionIdentity)
    private fun duration(opening: Boolean): Long = if (ValueAnimator.areAnimatorsEnabled()) if (opening) 160L else 140L else 0L

    override fun decorateChat(view: View): View {
        cancelMotion()
        val size = (36 * resources.displayMetrics.density).toInt()
        val panel = FrameLayout(this).apply {
            background = android.graphics.drawable.GradientDrawable().apply { setColor(Color.BLACK); cornerRadius = 20 * resources.displayMetrics.density }
            clipToOutline = true; isClickable = true
            addView(view, FrameLayout.LayoutParams(-1, -1).apply { topMargin = size })
            addView(android.widget.ImageButton(this@BubbleActivity).apply {
                setImageResource(android.R.drawable.arrow_down_float)
                imageTintList = android.content.res.ColorStateList.valueOf(Color.WHITE)
                setBackgroundColor(Color.TRANSPARENT)
                contentDescription = "Collapse chat"
                setOnClickListener { collapse() }
            }, FrameLayout.LayoutParams(size, size, Gravity.TOP or Gravity.END))
        }
        card = panel
        val shade = View(this).apply { setBackgroundColor(0x59000000); alpha = 0f }
        scrim = shade
        return object : FrameLayout(this) {
            override fun onMeasure(widthMeasureSpec: Int, heightMeasureSpec: Int) {
                panel.layoutParams.height = (View.MeasureSpec.getSize(heightMeasureSpec) * .88f).toInt()
                super.onMeasure(widthMeasureSpec, heightMeasureSpec)
            }
        }.apply {
            setOnClickListener { collapse() }
            addView(shade, FrameLayout.LayoutParams(-1, -1))
            addView(panel, FrameLayout.LayoutParams(-1, -1, Gravity.CENTER))
            panel.alpha = 0f
            panel.post { expand() }
        }
    }

    private fun anchor(panel: View): FloatArray {
        val location = IntArray(2); panel.getLocationOnScreen(location)
        val metrics = resources.displayMetrics
        val head = 64 * metrics.density
        val x = intent.getIntExtra("headX", metrics.widthPixels - head.toInt())
        val y = intent.getIntExtra("headY", (120 * metrics.density).toInt())
        val restingX = location[0] - panel.translationX
        val restingY = location[1] - panel.translationY
        return floatArrayOf(x-restingX, y-restingY, head / panel.width.coerceAtLeast(1), head / panel.height.coerceAtLeast(1))
    }
    private fun cancelMotion() {
        card?.animate()?.withEndAction(null)?.cancel()
        scrim?.animate()?.cancel()
    }
    private fun expand() {
        val panel = card ?: return
        if (panel.width == 0 || panel.height == 0 || isFinishing || motion == Motion.OPENING || motion == Motion.EXPANDED) return
        cancelMotion(); motion = Motion.OPENING
        val anchor = anchor(panel)
        panel.pivotX = 0f; panel.pivotY = 0f
        panel.translationX = anchor[0]; panel.translationY = anchor[1]
        panel.scaleX = anchor[2]; panel.scaleY = anchor[3]; panel.alpha = .6f
        val elapsed = android.os.SystemClock.uptimeMillis()
        firstFrameAt = 0L
        val timing = intent.getLongExtra("bubbleTapAt", elapsed)
        panel.viewTreeObserver.addOnPreDrawListener(object : android.view.ViewTreeObserver.OnPreDrawListener {
            override fun onPreDraw(): Boolean {
                panel.viewTreeObserver.removeOnPreDrawListener(this)
                firstFrameAt = android.os.SystemClock.uptimeMillis()
                android.util.Log.i("KenanBubble", "firstFrameMs=${firstFrameAt-timing}")
                return true
            }
        })
        scrim?.animate()?.alpha(1f)?.setDuration(duration(true))?.start()
        panel.animate().translationX(0f).translationY(0f).scaleX(1f).scaleY(1f).alpha(1f)
            .setDuration(duration(true)).setInterpolator(android.view.animation.PathInterpolator(.2f, 0f, 0f, 1f))
            .withEndAction {
                motion = Motion.EXPANDED; expandedAt = android.os.SystemClock.uptimeMillis()
                android.util.Log.i("KenanBubble", "expandedMs=${expandedAt-timing}")
            }.start()
    }
    internal fun collapse() {
        android.util.Log.i("KenanBubble", "collapse requested motion=$motion task=$taskId")
        val panel = card ?: return
        if (motion == Motion.CLOSING || motion == Motion.COLLAPSED) return
        cancelMotion(); motion = Motion.CLOSING
        val anchor = anchor(panel)
        scrim?.animate()?.alpha(0f)?.setDuration(duration(false))?.start()
        panel.animate().translationX(anchor[0]).translationY(anchor[1]).scaleX(anchor[2]).scaleY(anchor[3]).alpha(0f)
            .setDuration(duration(false)).setInterpolator(android.view.animation.PathInterpolator(.4f, 0f, 1f, 1f))
            .withEndAction {
                motion = Motion.COLLAPSED
                val moved = moveTaskToBack(true)
                android.util.Log.i("KenanBubble", "collapsed task=$taskId moved=$moved")
                overridePendingTransition(0, 0)
            }.start()
    }
    override fun leave() { if (card?.isAttachedToWindow == true) collapse() else super.leave() }
    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        overridePendingTransition(0, 0)
        card?.post { expand() }
    }
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        liveWindow?.get()?.takeIf { it !== this }?.finish()
        liveWindow = java.lang.ref.WeakReference(this)
        overridePendingTransition(0, 0)
        window.decorView.setBackgroundColor(Color.TRANSPARENT)
        window.statusBarColor = Color.TRANSPARENT; window.navigationBarColor = Color.TRANSPARENT
        window.setLayout(WindowManager.LayoutParams.MATCH_PARENT, WindowManager.LayoutParams.MATCH_PARENT)
        window.setGravity(Gravity.CENTER)
        window.clearFlags(WindowManager.LayoutParams.FLAG_DIM_BEHIND)
        window.setSoftInputMode(WindowManager.LayoutParams.SOFT_INPUT_ADJUST_RESIZE)
        if (Build.VERSION.SDK_INT >= 31 && isLaunchedFromBubble) {
            startActivity(Intent(intent).setClass(this, BubbleActivity::class.java)
                .setFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_NO_ANIMATION)
                .setData(intent.data?.buildUpon()?.appendQueryParameter("floating", "1")?.build()))
            ChatHeads.retireSystemBubbles(this); finish()
        }
    }
    override fun onResume() {
        android.util.Log.i("KenanBubble", "resume motion=$motion task=$taskId")
        val previous = pausedSession
        super.onResume()
        if (previous != null && previous != session()) { android.util.Log.i("KenanBubble", "session changed; retiring task=$taskId"); finish(); return }
        if (Build.VERSION.SDK_INT >= 31 && isLaunchedFromBubble) return
        val p = getSharedPreferences("kenan-next-device", MODE_PRIVATE)
        val owner = intent.getStringExtra("accountId"); val domain = intent.getStringExtra("noticeDomainId"); val conversation = intent.getStringExtra("conversationId")
        if (owner != null && domain != null && conversation != null) {
            p.edit().putBoolean("chatHeadEnabled", true).apply()
            ChatHeads.offer(this, owner, domain, conversation, "Kenaznia", select = true)
        }
        card?.post { expand() }
        if (!Settings.canDrawOverlays(this) && !requestingOverlay) {
            requestingOverlay = true
            android.app.AlertDialog.Builder(this).setMessage("Allow ${APP_LABEL} to display over other apps to keep a single floating chat head. Your chat stays available here.")
                .setPositiveButton("Allow floating chat") { _, _ -> startActivity(Intent(Settings.ACTION_MANAGE_OVERLAY_PERMISSION, android.net.Uri.parse("package:$packageName"))) }
                .setNegativeButton("Not now", null).show()
        }
    }
    override fun onPause() {
        android.util.Log.i("KenanBubble", "pause motion=$motion task=$taskId")
        pausedSession = session(); cancelMotion(); motion = Motion.COLLAPSED
        super.onPause()
    }
    override fun onDestroy() {
        if (liveWindow?.get() === this) liveWindow = null
        android.util.Log.i("KenanBubble", "destroy task=$taskId finishing=$isFinishing changing=$isChangingConfigurations")
        cancelMotion(); card = null; scrim = null; super.onDestroy()
    }
}
