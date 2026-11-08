package com.example.kenan.android

import android.Manifest
import android.app.Activity
import android.content.Context
import android.content.pm.PackageManager
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.Paint
import android.graphics.Path
import android.graphics.RadialGradient
import android.graphics.RectF
import android.graphics.Shader
import android.hardware.GeomagneticField
import android.hardware.Sensor
import android.hardware.SensorEvent
import android.hardware.SensorEventListener
import android.hardware.SensorManager
import android.location.Location
import android.location.LocationListener
import android.location.LocationManager
import android.os.Build
import android.os.Bundle
import android.os.VibrationEffect
import android.os.Vibrator
import android.view.MotionEvent
import android.view.View
import android.view.WindowManager
import androidx.core.view.WindowCompat
import kotlin.math.PI
import kotlin.math.abs
import kotlin.math.acos
import kotlin.math.atan2
import kotlin.math.cos
import kotlin.math.hypot
import kotlin.math.min
import kotlin.math.sin
import kotlin.math.tanh

/** Points the phone's back at Sample forest's star or Example's. Location, time, compass and tilt only; no network. */
class FinderActivity : Activity(), SensorEventListener, LocationListener {
    private lateinit var finder: FinderView
    private lateinit var sensors: SensorManager
    private lateinit var locations: LocationManager
    private val rotation = FloatArray(9)
    private var fix: Location? = null
    private var declination = 0.0
    private var declinationAt = 0L

    override fun onCreate(state: Bundle?) {
        super.onCreate(state)
        WindowCompat.setDecorFitsSystemWindows(window, false)
        WindowCompat.getInsetsController(window, window.decorView).apply { isAppearanceLightStatusBars = false; isAppearanceLightNavigationBars = false }
        window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
        sensors = getSystemService(SENSOR_SERVICE) as SensorManager
        locations = getSystemService(LocationManager::class.java)
        finder = FinderView(this, getSharedPreferences("finder", MODE_PRIVATE).getInt("star", 0), { index -> getSharedPreferences("finder", MODE_PRIVATE).edit().putInt("star", index).apply() }, { finish() })
        setContentView(finder)
        if (checkSelfPermission(Manifest.permission.ACCESS_FINE_LOCATION) != PackageManager.PERMISSION_GRANTED) requestPermissions(arrayOf(Manifest.permission.ACCESS_FINE_LOCATION, Manifest.permission.ACCESS_COARSE_LOCATION), 1)
    }

    override fun onResume() {
        super.onResume()
        sensors.getDefaultSensor(Sensor.TYPE_ROTATION_VECTOR)?.let { sensors.registerListener(this, it, SensorManager.SENSOR_DELAY_GAME) }
        listen()
    }

    override fun onPause() {
        sensors.unregisterListener(this)
        locations.removeUpdates(this)
        super.onPause()
    }

    override fun onRequestPermissionsResult(requestCode: Int, permissions: Array<out String>, grantResults: IntArray) { listen() }

    @Suppress("MissingPermission")
    private fun listen() {
        if (checkSelfPermission(Manifest.permission.ACCESS_FINE_LOCATION) != PackageManager.PERMISSION_GRANTED && checkSelfPermission(Manifest.permission.ACCESS_COARSE_LOCATION) != PackageManager.PERMISSION_GRANTED) return
        for (provider in locations.allProviders) {
            runCatching { locations.getLastKnownLocation(provider)?.let { accept(it) } }
            if (provider != LocationManager.PASSIVE_PROVIDER) runCatching { locations.requestLocationUpdates(provider, 30_000L, 50f, this, mainLooper) }
        }
    }

    private fun accept(location: Location) {
        val old = fix
        if (old != null && old.time > location.time && location.accuracy > old.accuracy) return
        fix = location
        finder.place(location.latitude, location.longitude)
    }

    override fun onLocationChanged(location: Location) = accept(location)
    @Deprecated("Required before API 29") override fun onStatusChanged(provider: String?, status: Int, extras: Bundle?) {}
    override fun onAccuracyChanged(sensor: Sensor?, accuracy: Int) {}

    override fun onSensorChanged(event: SensorEvent) {
        val here = fix ?: return
        val now = System.currentTimeMillis()
        if (now - declinationAt > 600_000L) {
            declination = GeomagneticField(here.latitude.toFloat(), here.longitude.toFloat(), here.altitude.toFloat(), now).declination.toDouble()
            declinationAt = now
        }
        SensorManager.getRotationMatrixFromVector(rotation, event.values)
        finder.aim(rotation, declination, now)
    }
}

private val BG_TOP = Color.parseColor("#0f0f0f")
private val FG = Color.parseColor("#f4f4f4")
private val MUTED = Color.parseColor("#9a9a9a")
private val LINE = Color.parseColor("#3a3a3a")
private val AMBER = Color.parseColor("#f4a62a")
private val WARM = Color.parseColor("#f4e3bf")
private val GREEN = Color.parseColor("#4ade80")
private val RED = Color.parseColor("#e0283f")

/** The whole screen: a dial centred on the back of the phone. The star sits at its angular distance and direction from where the phone points; the edge of the dial is straight behind. */
private class FinderView(context: Context, private var selected: Int, private val remember: (Int) -> Unit, private val close: () -> Unit) : View(context) {
    private val density = resources.displayMetrics.density
    private val scaledDensity = resources.displayMetrics.scaledDensity
    private fun dp(v: Float) = v * density
    private val paint = Paint(Paint.ANTI_ALIAS_FLAG)
    private val path = Path()
    private val device = DoubleArray(3)
    private var shown = DoubleArray(3).also { it[2] = -1.0 }
    private var latitude = Double.NaN
    private var longitude = Double.NaN
    private var azimuth = 0.0
    private var altitude = 0.0
    private var haveAim = false
    private var onIt = false
    private var lastRotation = FloatArray(9)
    private var lastDeclination = 0.0
    private var insetTop = 0f
    private var insetBottom = 0f
    private val chips = Array(STARS.size) { RectF() }
    private val closeBox = RectF()
    private val vibrator = context.getSystemService(Vibrator::class.java)

    init {
        setBackgroundColor(BG_TOP)
        setOnApplyWindowInsetsListener { _, insets ->
            insetTop = if (Build.VERSION.SDK_INT >= 30) insets.getInsets(android.view.WindowInsets.Type.systemBars()).top.toFloat() else insets.systemWindowInsetTop.toFloat()
            insetBottom = if (Build.VERSION.SDK_INT >= 30) insets.getInsets(android.view.WindowInsets.Type.systemBars()).bottom.toFloat() else insets.systemWindowInsetBottom.toFloat()
            insets
        }
    }

    fun place(lat: Double, lon: Double) { latitude = lat; longitude = lon; invalidate() }

    fun aim(rotation: FloatArray, declination: Double, now: Long) {
        System.arraycopy(rotation, 0, lastRotation, 0, 9); lastDeclination = declination
        val star = STARS[selected]
        val h = forestSky.horizontal(star, now, latitude, longitude)
        azimuth = h.azimuth; altitude = h.altitude
        forestSky.inDevice(rotation, h.azimuth, h.altitude, declination, device)
        // A little smoothing so the dot glides.
        for (i in 0..2) shown[i] += (device[i] - shown[i]) * 0.35
        val n = hypot(hypot(shown[0], shown[1]), shown[2]); if (n > 0) for (i in 0..2) shown[i] /= n
        haveAim = true
        val off = offDegrees()
        if (!onIt && off < 2.0) { onIt = true; buzz() } else if (onIt && off > 4.0) onIt = false
        invalidate()
    }

    private fun offDegrees() = acos((-shown[2]).coerceIn(-1.0, 1.0)) * 180 / PI

    private fun buzz() { if (Build.VERSION.SDK_INT >= 26) vibrator?.vibrate(VibrationEffect.createOneShot(45, 200)) }

    override fun onTouchEvent(e: MotionEvent): Boolean {
        if (e.action != MotionEvent.ACTION_UP) return true
        if (closeBox.contains(e.x, e.y)) { close(); return true }
        chips.forEachIndexed { i, box -> if (box.contains(e.x, e.y) && i != selected) { selected = i; remember(i); onIt = false; invalidate() } }
        return true
    }

    private fun below() = altitude < 0

    override fun onDraw(c: Canvas) {
        val w = width.toFloat(); val h = height.toFloat()
        val accent = if (onIt) GREEN else if (STARS[selected].name == "Example") WARM else AMBER
        val cx = w / 2; val cy = h * 0.46f
        val rMax = min(w * 0.44f, h * 0.30f)

        // The star's glow lights the dial; deeper below the horizon it sinks into the dark.
        paint.reset(); paint.isAntiAlias = true
        paint.shader = RadialGradient(cx, cy, rMax * 1.5f, intArrayOf(withAlpha(accent, if (onIt) 60 else if (below()) 22 else 34), Color.TRANSPARENT), null, Shader.TileMode.CLAMP)
        c.drawRect(0f, 0f, w, h, paint); paint.shader = null

        // Dial rim: directly behind the phone.
        paint.style = Paint.Style.STROKE; paint.strokeWidth = dp(1f); paint.color = LINE
        c.drawCircle(cx, cy, rMax, paint)
        paint.color = withAlpha(LINE, 120)
        for (deg in intArrayOf(30, 60, 90, 120)) c.drawCircle(cx, cy, (tanh(deg * PI / 180) / tanh(PI) * rMax).toFloat(), paint)

        if (haveAim) {
            drawHorizon(c, cx, cy, rMax)
            drawStar(c, cx, cy, rMax, accent)
        }

        // The phone's own aim: the reticle at the centre.
        paint.style = Paint.Style.STROKE; paint.strokeWidth = dp(if (onIt) 3f else 1.5f); paint.color = if (onIt) GREEN else FG
        c.drawCircle(cx, cy, dp(14f), paint)
        paint.strokeWidth = dp(1.5f)
        for (a in 0 until 4) { val dx = if (a == 0) 1 else if (a == 2) -1 else 0; val dy = if (a == 1) 1 else if (a == 3) -1 else 0
            c.drawLine(cx + dx * dp(20f), cy + dy * dp(20f), cx + dx * dp(30f), cy + dy * dp(30f), paint) }

        drawChips(c, w)
        drawGauge(c, w, h, accent)
        drawReadout(c, w, h, accent)
    }

    /** Dial position of a direction in the phone's frame. */
    private fun dialPoint(d: DoubleArray, cx: Float, cy: Float, rMax: Float, out: FloatArray) {
        val off = acos((-d[2]).coerceIn(-1.0, 1.0))
        val r = (tanh(off) / tanh(PI) * rMax).toFloat()
        val m = hypot(d[0], d[1])
        val ux = if (m < 1e-9) 0.0 else d[0] / m; val uy = if (m < 1e-9) 0.0 else d[1] / m
        out[0] = cx + (ux * r).toFloat(); out[1] = cy - (uy * r).toFloat()
    }

    private fun drawHorizon(c: Canvas, cx: Float, cy: Float, rMax: Float) {
        val p = FloatArray(2); val d = DoubleArray(3)
        path.reset(); var started = false
        paint.style = Paint.Style.STROKE; paint.strokeWidth = dp(1.5f); paint.color = withAlpha(FG, 90)
        for (step in 0..72) {
            forestSky.inDevice(lastRotation, step * 5.0, 0.0, lastDeclination, d)
            dialPoint(d, cx, cy, rMax, p)
            if (!started) { path.moveTo(p[0], p[1]); started = true } else path.lineTo(p[0], p[1])
            if (step % 18 == 0 && step < 72) { // N E S W
                paint.style = Paint.Style.FILL; paint.textSize = dp(11f); paint.textAlign = Paint.Align.CENTER; paint.color = withAlpha(FG, 140)
                c.drawText(arrayOf("N", "E", "S", "W")[step / 18], p[0], p[1] - dp(6f), paint)
                paint.style = Paint.Style.STROKE; paint.color = withAlpha(FG, 90)
            }
        }
        c.drawPath(path, paint)
    }

    private fun drawStar(c: Canvas, cx: Float, cy: Float, rMax: Float, accent: Int) {
        val p = FloatArray(2); dialPoint(shown, cx, cy, rMax, p)
        val behind = shown[2] > 0
        val pulse = (0.5 + 0.5 * sin(System.currentTimeMillis() / 420.0)).toFloat()
        // Guide line from the reticle toward the star.
        paint.style = Paint.Style.STROKE; paint.strokeWidth = dp(1f); paint.color = withAlpha(accent, if (onIt) 0 else 70)
        c.drawLine(cx, cy, p[0], p[1], paint)
        paint.shader = RadialGradient(p[0], p[1], dp(46f + 10f * pulse), intArrayOf(withAlpha(accent, if (below()) 110 else 170), Color.TRANSPARENT), null, Shader.TileMode.CLAMP)
        paint.style = Paint.Style.FILL; c.drawCircle(p[0], p[1], dp(56f), paint); paint.shader = null
        if (below()) { // beneath you: the star shown as a ring seen through the ground
            paint.style = Paint.Style.STROKE; paint.strokeWidth = dp(2f); paint.color = accent
            c.drawCircle(p[0], p[1], dp(9f), paint)
            paint.strokeWidth = dp(1f); paint.color = withAlpha(accent, 120)
            c.drawCircle(p[0], p[1], dp(15f + 3f * pulse), paint)
        } else {
            paint.style = Paint.Style.FILL; paint.color = accent
            c.drawCircle(p[0], p[1], dp(if (behind) 6f else 8f), paint)
        }
        if (onIt) { paint.style = Paint.Style.STROKE; paint.strokeWidth = dp(2f); paint.color = withAlpha(GREEN, (255 * (1 - pulse * 0.6f)).toInt()); c.drawCircle(cx, cy, dp(26f + 16f * pulse), paint) }
    }

    private fun drawChips(c: Canvas, w: Float) {
        val top = insetTop + dp(14f); val hgt = dp(36f)
        paint.textSize = dp(14f); paint.textAlign = Paint.Align.CENTER
        var x = dp(16f)
        closeBox.set(w - dp(16f) - hgt, top, w - dp(16f), top + hgt)
        paint.style = Paint.Style.STROKE; paint.strokeWidth = dp(1.8f); paint.color = MUTED
        val mx = closeBox.centerX(); val my = closeBox.centerY(); val s = dp(7f)
        c.drawLine(mx - s, my - s, mx + s, my + s, paint); c.drawLine(mx - s, my + s, mx + s, my - s, paint)
        for ((i, star) in STARS.withIndex()) {
            val width = paint.measureText(star.name) + dp(28f)
            chips[i].set(x, top, x + width, top + hgt)
            val on = i == selected
            paint.style = Paint.Style.FILL; paint.color = if (on) withAlpha(FG, 36) else Color.TRANSPARENT
            c.drawRoundRect(chips[i], hgt / 2, hgt / 2, paint)
            paint.style = Paint.Style.STROKE; paint.strokeWidth = dp(1f); paint.color = if (on) FG else LINE
            c.drawRoundRect(chips[i], hgt / 2, hgt / 2, paint)
            paint.style = Paint.Style.FILL; paint.color = if (on) FG else MUTED
            c.drawText(star.name, chips[i].centerX(), chips[i].centerY() + dp(5f), paint)
            x += width + dp(8f)
        }
    }

    /** Altitude from +90 at the top to −90 at the bottom; the part below the horizon is filled. */
    private fun drawGauge(c: Canvas, w: Float, h: Float, accent: Int) {
        if (!haveAim) return
        val x = w - dp(22f); val top = h * 0.28f; val bottom = h * 0.64f; val mid = (top + bottom) / 2
        paint.style = Paint.Style.STROKE; paint.strokeWidth = dp(1f); paint.color = LINE
        c.drawLine(x, top, x, bottom, paint)
        paint.color = withAlpha(FG, 140); c.drawLine(x - dp(7f), mid, x + dp(7f), mid, paint)
        val y = (mid - (altitude / 90.0).coerceIn(-1.0, 1.0) * (bottom - mid)).toFloat()
        if (below()) { paint.strokeWidth = dp(3f); paint.color = withAlpha(accent, 150); c.drawLine(x, mid, x, y, paint) }
        paint.style = Paint.Style.FILL; paint.color = accent
        c.drawCircle(x, y, dp(5f), paint)
    }

    private fun drawReadout(c: Canvas, w: Float, h: Float, accent: Int) {
        val x = w / 2; var y = h - insetBottom - dp(36f)
        paint.style = Paint.Style.FILL; paint.textAlign = Paint.Align.CENTER
        if (latitude.isNaN()) { paint.textSize = dp(18f); paint.color = MUTED; c.drawText("Locating", x, y, paint); return }
        paint.textSize = dp(14f); paint.color = MUTED
        c.drawText(String.format("Az %.1f°   Alt %+.1f°", azimuth, altitude), x, y, paint)
        y -= dp(30f)
        paint.textSize = dp(18f); paint.color = FG
        c.drawText(if (below()) String.format("%.1f° below the horizon", -altitude) else String.format("%.1f° above the horizon", altitude), x, y, paint)
        y -= dp(40f)
        paint.textSize = dp(32f); paint.color = accent; paint.isFakeBoldText = true
        c.drawText(if (below()) "Beneath you" else STARS[selected].name, x, y, paint)
        paint.isFakeBoldText = false
    }

    private fun withAlpha(color: Int, a: Int) = Color.argb(a.coerceIn(0, 255), Color.red(color), Color.green(color), Color.blue(color))

    // The pulse and the glow redraw once a frame even when the phone is still.
    override fun onAttachedToWindow() { super.onAttachedToWindow(); postOnAnimation(tick) }
    private val tick = object : Runnable { override fun run() { invalidate(); if (isAttachedToWindow) postOnAnimation(this) } }
}
