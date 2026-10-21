package com.example.kenan.android

import java.security.MessageDigest

/** Stable across new messages and reconnects, isolated across accounts and domains. */
fun conversationShortcutId(account: String, domain: String, conversation: String): String {
    val identity = listOf(account, domain, conversation).joinToString("") { "${it.length}:$it" }
    return "chat-" + MessageDigest.getInstance("SHA-256").digest(identity.toByteArray()).joinToString("") { "%02x".format(it) }
}
