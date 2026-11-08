package com.example.kenan.android

import android.app.Notification
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
        val notification = sbn.notification
        val style = NotificationCompat.MessagingStyle.extractMessagingStyleFromNotification(notification)
        if (style == null) {
            if (notification.flags and Notification.FLAG_GROUP_SUMMARY != 0) return
            val sender = notification.extras.getCharSequence(Notification.EXTRA_TITLE)?.toString()?.takeIf { it.isNotBlank() } ?: return
            val body = (notification.extras.getCharSequence(Notification.EXTRA_BIG_TEXT)
                ?: notification.extras.getCharSequence(Notification.EXTRA_TEXT))?.toString()?.takeIf { it.isNotBlank() } ?: return
            Texts.submit(this, listOf(Texts.Text(Texts.id("notification", sbn.packageName, sender, sbn.postTime, body),
                "notification", sbn.packageName, sender, body, sbn.postTime)))
            return
        }
        val texts = style.messages.mapNotNull { message ->
            // A message without a person is one the phone's owner sent.
            val sender = message.person?.takeIf { it.name != style.user.name }?.name?.toString() ?: return@mapNotNull null
            val body = message.text?.toString()?.takeIf { it.isNotBlank() } ?: return@mapNotNull null
            Texts.Text(Texts.id("notification", sbn.packageName, sender, message.timestamp, body), "notification", sbn.packageName, sender, body, message.timestamp)
        }
        if (texts.isNotEmpty()) Texts.submit(this, texts)
    }
}
