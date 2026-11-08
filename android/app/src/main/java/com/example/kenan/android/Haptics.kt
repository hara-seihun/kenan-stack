package com.example.kenan.android

import android.os.Build
import android.view.HapticFeedbackConstants

/** CONFIRM exists from API 30; older phones get the closest older click. */
internal val CONFIRM_HAPTIC: Int = if (Build.VERSION.SDK_INT >= 30) HapticFeedbackConstants.CONFIRM else HapticFeedbackConstants.VIRTUAL_KEY
