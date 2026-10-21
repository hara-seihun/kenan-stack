package com.example.kenan.android

import org.json.JSONObject
import java.security.MessageDigest
import java.security.Signature
import java.security.cert.CertificateFactory
import java.util.Base64

const val BETA_ORIGIN = BuildConfig.GATEWAY_ORIGIN
const val APP_LABEL = BuildConfig.APP_LABEL

data class BetaRelease private constructor(val versionCode: Long, val versionName: String, val size: Long, val sha256: String) {
    fun download(origin: String): JSONObject = JSONObject().put("url", "$origin/api/android/apk/$sha256.apk")
        .put("versionCode", versionCode).put("size", size).put("sha256", sha256)
    companion object {
        fun verify(envelope: String, signerDer: ByteArray): Outcome<BetaRelease> {
            return try {
                require(envelope.toByteArray(Charsets.UTF_8).size <= 8192) { "Signed release exceeds the feed limit" }
                val outer = JSONObject(envelope)
                require(outer.keys().asSequence().toSet() == setOf("payload", "signature")) { "Unknown release envelope" }
                val payloadText = outer.get("payload"); val signatureText = outer.get("signature")
                require(payloadText is String && signatureText is String)
                val payload = Base64.getDecoder().decode(payloadText); val signature = Base64.getDecoder().decode(signatureText)
                require(payload.size in 1..4096 && signature.size in 1..1024 && Base64.getEncoder().encodeToString(payload) == payloadText && Base64.getEncoder().encodeToString(signature) == signatureText)
                val certificate = CertificateFactory.getInstance("X.509").generateCertificate(signerDer.inputStream())
                require(certificate.publicKey.algorithm == "RSA") { "${APP_LABEL} signing algorithm is unsupported" }
                val verifier = Signature.getInstance("SHA256withRSA"); verifier.initVerify(certificate); verifier.update(payload)
                require(verifier.verify(signature)) { "${APP_LABEL} release signature is invalid" }
                val m = JSONObject(String(payload, Charsets.UTF_8))
                require(m.keys().asSequence().toSet() == setOf("protocol", "package", "label", "versionCode", "versionName", "size", "sha256", "signerCertificateSha256")) { "Unknown ${APP_LABEL} release fields" }
                require(m.get("protocol") == 1 && m.get("package") == BuildConfig.APPLICATION_ID) { "Release package does not match this app" }
                val version = integer(m, "versionCode"); val size = integer(m, "size")
                val name = m.get("versionName"); val hash = m.get("sha256"); val certHash = m.get("signerCertificateSha256")
                require(version in 1..2100000000 && size > 0 && name is String && name.length in 1..100 && hash is String && hash.matches(Regex("[a-f0-9]{64}"))) { "Invalid ${APP_LABEL} release metadata" }
                require(certHash is String && certHash == MessageDigest.getInstance("SHA-256").digest(signerDer).joinToString("") { "%02x".format(it) }) { "Release certificate differs from installed app" }
                Outcome.Ok(BetaRelease(version, name, size, hash))
            } catch (error: Exception) { Outcome.Err("invalid_input", "${APP_LABEL} feed verification failed: ${error.message ?: error.javaClass.simpleName}") }
        }
        private fun integer(value: JSONObject, key: String): Long {
            return when (val number = value.get(key)) {
                is Int -> number.toLong()
                is Long -> number
                else -> throw IllegalArgumentException("$key must be an integer")
            }
        }
    }
}
sealed interface ReleaseDecision {
    data object Current : ReleaseDecision
    data class Newer(val release: BetaRelease) : ReleaseDecision
}
fun releaseDecision(release: BetaRelease, installed: Long): Outcome<ReleaseDecision> = when {
    installed < 1 -> Outcome.Err("invalid_input", "Installed ${APP_LABEL} version is invalid")
    release.versionCode < installed -> Outcome.Err("identity_conflict", "${APP_LABEL} feed version is older than this installation; downgrade refused")
    release.versionCode == installed -> Outcome.Ok(ReleaseDecision.Current)
    else -> Outcome.Ok(ReleaseDecision.Newer(release))
}
