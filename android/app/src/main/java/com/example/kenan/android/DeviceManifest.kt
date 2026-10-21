package com.example.kenan.android

object DeviceManifest {
    const val PROTOCOL = 1
    const val MAX_FRAME_BYTES = 8388608
    val COMMANDS = setOf<String>("ui.tree", "ui.tap", "ui.swipe", "ui.text", "ui.global", "screenshot", "app.list", "app.launch", "url.open", "clipboard.read", "clipboard.write", "notifications.list", "notifications.dismiss", "notifications.action", "notifications.reply", "files.list", "files.read", "files.write", "files.delete", "contacts.list", "calendar.list", "location.last", "sms.list", "sms.send", "calls.list", "calls.dial", "usage.list", "settings.read", "settings.open", "lock")
    val CONFIRMATION_REQUIRED = setOf<String>()
    val ERRORS = setOf<String>("invalid_input", "forbidden", "permission_missing", "unsupported", "deadline_expired", "disconnected", "identity_conflict", "outcome_uncertain", "platform_failure", "storage_failure")
    val BRIDGE_COMMANDS = setOf<String>("status", "disconnect", "openSettings", "overlay", "haptic", "apkUpdate", "refreshSession", "threadPresence")
    val CLIENT_FRAMES = setOf<String>("hello", "result", "heartbeat", "ack", "overlayInput", "error")
    val SERVER_FRAMES = setOf<String>("ready", "command", "noticeBatch", "ack", "overlayReply", "heartbeat", "error")
    val CAPABILITY_STATES = setOf<String>("available", "permission_missing", "unsupported")
}
