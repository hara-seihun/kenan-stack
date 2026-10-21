package com.example.kenan.android

import android.service.notification.NotificationListenerService
import android.service.notification.StatusBarNotification
import android.provider.Telephony
import androidx.core.app.NotificationCompat

/** Notification access: forwards the messages the default messaging app shows (SMS, RCS chat) as texts for the agents. */
class PhoneNotifications : NotificationListenerService() {
    override fun onListenerConnected() { activeNotifications?.forEach(::forward) }
    override fun onNotificationPosted(sbn: StatusBarNotification) = forward(sbn)

    private fun forward(sbn: StatusBarNotification) {
        val messaging = Telephony.Sms.getDefaultSmsPackage(this) ?: return
        if (sbn.packageName != messaging) return
        val style = NotificationCompat.MessagingStyle.extractMessagingStyleFromNotification(sbn.notification) ?: return
        val texts = style.messages.mapNotNull { message ->
            // A message without a person is one the phone's owner sent.
            val sender = message.person?.takeIf { it.name != style.user.name }?.name?.toString() ?: return@mapNotNull null
            val body = message.text?.toString()?.takeIf { it.isNotBlank() } ?: return@mapNotNull null
            Texts.Text(Texts.id("notification", sbn.packageName, sender, message.timestamp, body), "notification", sbn.packageName, sender, body, message.timestamp)
        }
        if (texts.isNotEmpty()) Texts.submit(this, texts)
    }
}
