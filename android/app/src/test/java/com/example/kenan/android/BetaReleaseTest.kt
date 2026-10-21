package com.example.kenan.android

import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test
import java.security.KeyFactory
import java.security.MessageDigest
import java.security.Signature
import java.security.spec.PKCS8EncodedKeySpec
import java.util.Base64

class BetaReleaseTest {
    private val cert = javaClass.getResourceAsStream("/test-only.der")!!.use { it.readBytes() }
    private val key = KeyFactory.getInstance("RSA").generatePrivate(PKCS8EncodedKeySpec(javaClass.getResourceAsStream("/test-only.pk8")!!.use { it.readBytes() }))
    private fun metadata() = JSONObject().put("protocol", 1).put("package", BuildConfig.APPLICATION_ID).put("label", APP_LABEL)
        .put("versionCode", 14).put("versionName", "0.1.13").put("size", 100).put("sha256", "a".repeat(64))
        .put("signerCertificateSha256", MessageDigest.getInstance("SHA-256").digest(cert).joinToString("") { "%02x".format(it) })
    private fun envelope(metadata: JSONObject): String {
        val bytes = metadata.toString().toByteArray(Charsets.UTF_8)
        val signature = Signature.getInstance("SHA256withRSA"); signature.initSign(key); signature.update(bytes)
        return JSONObject().put("payload", Base64.getEncoder().encodeToString(bytes)).put("signature", Base64.getEncoder().encodeToString(signature.sign())).toString()
    }
    @Test fun installedSignerControlsReleaseAndMonotonicDecision() {
        val checked = BetaRelease.verify(envelope(metadata()), cert)
        assertTrue(checked is Outcome.Ok)
        val release = (checked as Outcome.Ok).value
        assertEquals(ReleaseDecision.Current, (releaseDecision(release, 14) as Outcome.Ok).value)
        assertTrue(releaseDecision(release, 15) is Outcome.Err)
        assertTrue((releaseDecision(release, 13) as Outcome.Ok).value is ReleaseDecision.Newer)
        assertEquals("https://beta.example/api/android/apk/${"a".repeat(64)}.apk", release.download("https://beta.example").getString("url"))
    }
    @Test fun cosmeticLabelAndLargeVerifiedPackagesDoNotBlockUpdates() {
        assertTrue(BetaRelease.verify(envelope(metadata().put("label", "Kenan").put("size", 100L * 1024 * 1024)), cert) is Outcome.Ok)
    }
    @Test fun rejectsTamperingCoercionsProductionAndUnknownFields() {
        val outer = JSONObject(envelope(metadata()))
        outer.put("payload", Base64.getEncoder().encodeToString(metadata().put("versionCode", 15).toString().toByteArray()))
        assertTrue(BetaRelease.verify(outer.toString(), cert) is Outcome.Err)
        for (m in listOf(metadata().put("package", if (BuildConfig.RELEASE_CHANNEL == "production") "com.example.kenan.android" else "com.example.kenan.piremote.kenan"), metadata().put("versionCode", "14"), metadata().put("size", 0),
            metadata().put("signerCertificateSha256", "b".repeat(64)), metadata().put("url", "https://attacker.example/app.apk"), metadata().put("versionCode", 1.5))) {
            assertTrue(BetaRelease.verify(envelope(m), cert) is Outcome.Err)
        }
        assertTrue(BetaRelease.verify("x".repeat(8193), cert) is Outcome.Err)
        assertTrue(BetaRelease.verify("{}", cert) is Outcome.Err)
    }
}
