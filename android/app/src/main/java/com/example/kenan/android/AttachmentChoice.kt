package com.example.kenan.android

internal enum class AttachmentChoice { FILE, PHOTO, CAMERA }
internal fun attachmentChoice(accept: Array<String>, capture: Boolean): AttachmentChoice {
    val types = accept.flatMap { it.split(',') }.map { it.trim().lowercase() }.filter { it.isNotEmpty() }
    val images = types.isNotEmpty() && types.all { it.startsWith("image/") }
    return if (!images) AttachmentChoice.FILE else if (capture) AttachmentChoice.CAMERA else AttachmentChoice.PHOTO
}
