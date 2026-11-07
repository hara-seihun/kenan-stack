package com.example.kenan.android

import kotlin.math.PI
import kotlin.math.asin
import kotlin.math.atan2
import kotlin.math.cos
import kotlin.math.sin

/** A catalogue star: Gaia DR3 position at epoch 2016.0 (ICRS, degrees), proper motion (mas/yr, pmRa already times cos dec). */
internal class Star(val name: String, val ra: Double, val dec: Double, val pmRa: Double, val pmDec: Double)

/** The two targets, straight from Gaia DR3. Everything below runs on the phone; nothing leaves it. */
internal val STARS = listOf(
    Star("Sample forest", 56.31870826021668, -60.90886391935923, 171.13083428722373, 163.0752221714331),
    Star("Example", 66.28749703532576, -64.07864140698923, -61.98059512389874, 321.3852177323411),
)

/** Where a star is in the local sky: azimuth from true north through east, altitude above the horizon (negative: below it), degrees. */
internal class Horizontal(val azimuth: Double, val altitude: Double)

internal object forestSky {
    private const val RAD = PI / 180.0
    private const val GAIA_EPOCH_JD = 2457389.0 // J2016.0

    fun julianDay(unixMillis: Long) = unixMillis / 86_400_000.0 + 2440587.5

    /** Greenwich mean sidereal time, degrees (Meeus 12.4). */
    fun gmst(jd: Double): Double {
        val t = (jd - 2451545.0) / 36525.0
        val d = jd - 2451545.0
        return (280.46061837 + 360.98564736629 * d + 0.000387933 * t * t - t * t * t / 38710000.0).mod(360.0)
    }

    /** The star's apparent-of-date RA/Dec in radians: proper motion from 2016.0, then precession J2000 to the date (Meeus 21). */
    fun ofDate(star: Star, jd: Double): DoubleArray {
        val years = (jd - GAIA_EPOCH_JD) / 365.25
        val dec0 = (star.dec + star.pmDec * years / 3_600_000.0) * RAD
        val ra0 = (star.ra + star.pmRa * years / 3_600_000.0 / cos(star.dec * RAD)) * RAD
        val t = (jd - 2451545.0) / 36525.0
        val arc = RAD / 3600.0
        val zeta = (2306.2181 * t + 0.30188 * t * t + 0.017998 * t * t * t) * arc
        val z = (2306.2181 * t + 1.09468 * t * t + 0.018203 * t * t * t) * arc
        val theta = (2004.3109 * t - 0.42665 * t * t - 0.041833 * t * t * t) * arc
        val a = cos(dec0) * sin(ra0 + zeta)
        val b = cos(theta) * cos(dec0) * cos(ra0 + zeta) - sin(theta) * sin(dec0)
        val c = sin(theta) * cos(dec0) * cos(ra0 + zeta) + cos(theta) * sin(dec0)
        return doubleArrayOf(atan2(a, b) + z, asin(c))
    }

    fun horizontal(star: Star, unixMillis: Long, latitude: Double, longitude: Double): Horizontal {
        val jd = julianDay(unixMillis)
        val (ra, dec) = ofDate(star, jd).let { it[0] to it[1] }
        val hourAngle = (gmst(jd) + longitude) * RAD - ra
        val lat = latitude * RAD
        val east = -cos(dec) * sin(hourAngle)
        val north = sin(dec) * cos(lat) - cos(dec) * sin(lat) * cos(hourAngle)
        val up = sin(dec) * sin(lat) + cos(dec) * cos(lat) * cos(hourAngle)
        return Horizontal((atan2(east, north) / RAD).mod(360.0), asin(up.coerceIn(-1.0, 1.0)) / RAD)
    }

    /** A direction in the phone's frame (x right, y up the screen, z out of the screen) from a rotation matrix whose world axes are east, north, up of the magnetic frame. */
    fun inDevice(rotation: FloatArray, azimuth: Double, altitude: Double, declination: Double, out: DoubleArray) {
        val az = (azimuth - declination) * RAD // magnetic azimuth = true azimuth minus the declination east
        val alt = altitude * RAD
        val w0 = sin(az) * cos(alt); val w1 = cos(az) * cos(alt); val w2 = sin(alt)
        for (i in 0..2) out[i] = rotation[i] * w0 + rotation[3 + i] * w1 + rotation[6 + i] * w2
    }
}
