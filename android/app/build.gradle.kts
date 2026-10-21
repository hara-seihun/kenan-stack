import java.util.Properties
import groovy.json.JsonSlurper

plugins { id("com.android.application"); id("org.jetbrains.kotlin.android") }
val channel = providers.gradleProperty("kenanChannel").orNull ?: error("Supply explicit kenanChannel=beta or production")
require(channel in listOf("beta", "production")) { "kenanChannel must be beta or production" }
val production = channel == "production"
val channels = JsonSlurper().parse(rootDir.resolve("channels.json")) as? Map<*, *> ?: error("App channel authority is invalid")
val identity = channels[channel] as? Map<*, *> ?: error("App channel identity is unset")
fun identityString(name: String): String = (identity[name] as? String)?.takeIf { it.isNotBlank() } ?: error("App channel field is unset: $name")
val appLabel = identityString("label")
val signingFile = file("/etc/kenan/android-signing.properties")
val releaseSigning = Properties()
if (!production && signingFile.isFile) signingFile.inputStream().use { releaseSigning.load(it) }
val versionCodeInput = providers.gradleProperty("kenanVersionCode").orNull
val versionNameInput = providers.gradleProperty("kenanVersionName").orNull
val appVersion = if (versionCodeInput == null && versionNameInput == null) if (production) Pair(11671, "1.2.0") else Pair(48, "1.3.48") else {
    val code = versionCodeInput?.toIntOrNull()
    require(code != null && code in 1..2100000000 && !versionNameInput.isNullOrBlank() && versionNameInput.length <= 100) { "Supply valid kenanVersionCode and kenanVersionName together" }
    Pair(code, versionNameInput)
}
android {
    namespace = "com.example.kenan.android"
    sourceSets.getByName("main").res.srcDir("src/$channel/res")
    compileSdk = 36
    buildToolsVersion = "36.0.0"
    defaultConfig {
        applicationId = identityString("androidPackage")
        buildConfigField("String", "GATEWAY_ORIGIN", "\"${identityString("gatewayOrigin")}\"")
        buildConfigField("String", "APP_LABEL", "\"$appLabel\"")
        buildConfigField("String", "RELEASE_CHANNEL", "\"$channel\"")
        resValue("string", "app_name", appLabel)
        minSdk = 26
        targetSdk = 36
        versionCode = appVersion.first
        versionName = appVersion.second
        testInstrumentationRunner = "androidx.test.runner.AndroidJUnitRunner"
    }
    signingConfigs {
        getByName("debug") {
            storeFile = file("/var/cache/kenan/android/next-debug.keystore")
            storePassword = "android"
            keyAlias = "androiddebugkey"
            keyPassword = "android"
        }
    }
    signingConfigs.create("release") {
        if (production) {
            storeFile = file("/home/kenan/.android/debug.keystore")
            storePassword = "android"
            keyAlias = "androiddebugkey"
            keyPassword = "android"
        } else if (signingFile.isFile) {
            check(releaseSigning.getProperty("storeFile") == "/etc/kenan/android-signing.jks")
            check(releaseSigning.getProperty("keyAlias") == "kenan-beta")
            listOf("storePassword", "keyPassword").forEach { check(!releaseSigning.getProperty(it).isNullOrEmpty()) { "Release signing property is unset: $it" } }
            storeFile = file(releaseSigning.getProperty("storeFile"))
            storePassword = releaseSigning.getProperty("storePassword")
            keyAlias = releaseSigning.getProperty("keyAlias")
            keyPassword = releaseSigning.getProperty("keyPassword")
        }
    }
    buildTypes.getByName("release") { signingConfig = signingConfigs.getByName("release"); isMinifyEnabled = false }
    buildFeatures { buildConfig = true }
    if (production) sourceSets.getByName("release").manifest.srcFile("src/production/AndroidManifest.xml")
    compileOptions { sourceCompatibility = JavaVersion.VERSION_21; targetCompatibility = JavaVersion.VERSION_21 }
    kotlinOptions { jvmTarget = "21" }
    val instrumentationBuild = providers.gradleProperty("kenanInstrumentationBuild").orNull
    if (instrumentationBuild != null) { require(instrumentationBuild == "release"); testBuildType = instrumentationBuild }
    testOptions { unitTests.isReturnDefaultValues = false }
    sourceSets.getByName("test").resources.srcDir(rootDir.parentFile.resolve("tests/fixtures/android-release"))
}
tasks.register("requireReleaseSigning") { doLast { check(if (production) file("/home/kenan/.android/debug.keystore").isFile else signingFile.isFile) { "The selected channel's existing signing identity is required" }; check(!production || appVersion.first >= 11671) { "Production must upgrade the published Kenan version 11670" } } }
tasks.matching { it.name == "preReleaseBuild" }.configureEach { dependsOn("requireReleaseSigning") }
dependencies {
    implementation("androidx.activity:activity-ktx:1.10.1")
    implementation("androidx.webkit:webkit:1.13.0")
    implementation("androidx.core:core-ktx:1.16.0")
    implementation("com.squareup.okhttp3:okhttp:4.12.0")
    testImplementation("junit:junit:4.13.2")
    testImplementation("org.json:json:20250107")
    androidTestImplementation("androidx.test:runner:1.6.2")
    androidTestImplementation("androidx.test:rules:1.6.1")
    androidTestImplementation("androidx.test.ext:junit:1.2.1")
    androidTestImplementation("androidx.test.uiautomator:uiautomator:2.3.0")
}
