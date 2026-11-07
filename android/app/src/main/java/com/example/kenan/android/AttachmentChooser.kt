package com.example.kenan.android

import android.Manifest
import android.app.Activity
import android.content.ClipData
import android.content.Intent
import android.content.pm.PackageManager
import android.net.Uri
import android.provider.MediaStore
import android.webkit.ValueCallback
import android.webkit.WebChromeClient
import androidx.activity.ComponentActivity
import androidx.activity.result.PickVisualMediaRequest
import androidx.activity.result.contract.ActivityResultContracts
import androidx.core.content.ContextCompat
import androidx.core.content.FileProvider
import java.io.File
import java.util.UUID

/** Owns one external selection; an old result can never satisfy a newer web callback. */
internal class AttachmentChooser(private val activity: ComponentActivity, private val message: (String) -> Unit) {
    private val prefs = activity.getSharedPreferences("attachment-capture", Activity.MODE_PRIVATE)
    private var callback: ValueCallback<Array<Uri>>? = null
    private var valid: (() -> Boolean)? = null
    private var busy = false
    private var binding: String? = null
    private val cameraFile: File? get() = prefs.getString("file", null)?.let { name ->
        if (!name.matches(Regex("photo-[a-f0-9-]+\\.jpg"))) null else File(directory(), name)
    }
    private val cameraUri: Uri? get() = cameraFile?.let { FileProvider.getUriForFile(activity, activity.packageName + ".attachments", it) }
    private val files = activity.registerForActivityResult(ActivityResultContracts.StartActivityForResult()) { result ->
        finishExternal(if (result.resultCode == Activity.RESULT_OK) WebChromeClient.FileChooserParams.parseResult(result.resultCode, result.data) else null)
    }
    private val photo = activity.registerForActivityResult(ActivityResultContracts.PickVisualMedia()) { uri -> finishExternal(uri?.let { arrayOf(it) }) }
    private val photos = activity.registerForActivityResult(ActivityResultContracts.PickMultipleVisualMedia()) { uris -> finishExternal(uris.takeIf { it.isNotEmpty() }?.toTypedArray()) }
    private val camera = activity.registerForActivityResult(ActivityResultContracts.StartActivityForResult()) { result ->
        val file = cameraFile
        val uri = cameraUri
        val success = result.resultCode == Activity.RESULT_OK && file != null && file.length() > 0 && uri != null
        if (uri != null) activity.revokeUriPermission(uri, Intent.FLAG_GRANT_WRITE_URI_PERMISSION or Intent.FLAG_GRANT_READ_URI_PERMISSION)
        if (success && callback == null) {
            // A recreated WebView cannot retain its JavaScript callback. Keep the original photo
            // and offer it only to a new camera input from the same authenticated session.
            prefs.edit().putBoolean("ready", true).commit()
            busy = false
            message("Photo saved. Tap the camera button again to attach it.")
        } else {
            if (!success) file?.delete()
            prefs.edit().clear().commit()
            finish(if (success) arrayOf(uri!!) else null)
        }
    }
    private val permission = activity.registerForActivityResult(ActivityResultContracts.RequestPermission()) { granted ->
        if (granted && callback != null && valid?.invoke() == true) launchCamera() else finish(null)
    }
    private fun directory() = File(activity.filesDir, "attachments").apply { mkdirs() }
    fun open(params: WebChromeClient.FileChooserParams, next: ValueCallback<Array<Uri>>, session: String, stillValid: () -> Boolean) {
        if (busy) { next.onReceiveValue(null); return }
        callback = next; valid = stillValid; binding = session; busy = true
        try {
            when (attachmentChoice(params.acceptTypes, params.isCaptureEnabled)) {
                AttachmentChoice.FILE -> files.launch(params.createIntent())
                AttachmentChoice.PHOTO -> {
                    val request = PickVisualMediaRequest(ActivityResultContracts.PickVisualMedia.ImageOnly)
                    if (params.mode == WebChromeClient.FileChooserParams.MODE_OPEN_MULTIPLE) photos.launch(request) else photo.launch(request)
                }
                AttachmentChoice.CAMERA -> {
                    if (prefs.getBoolean("ready", false) && prefs.getString("session", null) == session && cameraFile?.length()?.let { it > 0 } == true) {
                        val saved = cameraUri!!; prefs.edit().clear().commit(); finish(arrayOf(saved))
                    } else if (ContextCompat.checkSelfPermission(activity, Manifest.permission.CAMERA) != PackageManager.PERMISSION_GRANTED) permission.launch(Manifest.permission.CAMERA)
                    else launchCamera()
                }
            }
        } catch (error: Exception) { finish(null); message(error.message ?: "Attachment chooser unavailable") }
    }
    private fun launchCamera() {
        try {
            if (valid?.invoke() != true) { finish(null); return }
            val file = File(directory(), "photo-${UUID.randomUUID()}.jpg")
            check(file.createNewFile())
            check(prefs.edit().putString("file", file.name).putString("session", binding).putBoolean("ready", false).commit())
            val uri = cameraUri!!
            val intent = Intent(MediaStore.ACTION_IMAGE_CAPTURE).putExtra(MediaStore.EXTRA_OUTPUT, uri)
                .addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION or Intent.FLAG_GRANT_WRITE_URI_PERMISSION)
            intent.clipData = ClipData.newRawUri("Camera output", uri)
            camera.launch(intent)
        } catch (error: Exception) { cameraFile?.delete(); prefs.edit().clear().commit(); finish(null); message(error.message ?: "Camera unavailable") }
    }
    private fun finishExternal(uris: Array<Uri>?) {
        // External pickers must return granted provider URIs, never private app paths.
        val accepted = uris?.takeIf { values -> values.all { uri ->
            uri.scheme == "content" && uri.authority?.let { activity.packageManager.resolveContentProvider(it, 0)?.applicationInfo?.uid } != activity.applicationInfo.uid
        } }
        finish(accepted)
    }
    private fun finish(uris: Array<Uri>?) {
        val current = callback; val allowed = valid?.invoke() == true
        callback = null; valid = null; binding = null; busy = false
        current?.onReceiveValue(if (allowed) uris else null)
    }
    fun cancel() {
        val current = callback; callback = null; valid = null; binding = null
        current?.onReceiveValue(null)
        // Keep busy until the outstanding external result is drained; never retarget it.
    }
}
