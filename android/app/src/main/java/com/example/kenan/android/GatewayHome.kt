package com.example.kenan.android

import android.content.Context

/** Account services and signed updates follow the destination saved by the trusted bridge. */
fun accountOrigin(context: Context): String = context.getSharedPreferences("kenan-next-device", Context.MODE_PRIVATE)
    .getString("gateway", null)?.let { (Gateway.parse(it) as? Outcome.Ok)?.value?.origin } ?: DEFAULT_ORIGIN
