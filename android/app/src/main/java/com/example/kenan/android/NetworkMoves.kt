package com.example.kenan.android

import android.content.Context
import android.net.ConnectivityManager
import android.net.Network
import android.net.NetworkCapabilities
import android.os.Handler
import android.os.Looper

/**
 * Calls back on the main thread when the phone's default network moves: a different network, or the same one (a VPN
 * such as Tailscale) now running over Wi-Fi instead of cellular or the reverse. A connection opened before the move
 * usually dies without closing, so its owner replaces it at once. `first` is called once for the network in use at start.
 */
internal class NetworkMoves(context: Context, private val first: (Network) -> Unit, private val moved: () -> Unit) {
    private val main = Handler(Looper.getMainLooper())
    private val connectivity = context.applicationContext.getSystemService(ConnectivityManager::class.java)
    private var current: Pair<Network, List<Int>>? = null
    private var closed = false
    private val callback = object : ConnectivityManager.NetworkCallback() {
        override fun onAvailable(network: Network) { main.post { placed(network, null) } }
        override fun onCapabilitiesChanged(network: Network, capabilities: NetworkCapabilities) {
            val transports = TRANSPORTS.filter(capabilities::hasTransport)
            main.post { placed(network, transports) }
        }
    }
    init { connectivity.registerDefaultNetworkCallback(callback) }

    /** transports null: not known yet (onAvailable); the same network keeps what it had. */
    private fun placed(network: Network, known: List<Int>?) {
        if (closed) return
        val before = current
        val transports = known ?: before?.takeIf { it.first == network }?.second ?: emptyList()
        current = network to transports
        when {
            before == null -> first(network)
            before.first != network -> moved()
            before.second.isNotEmpty() && transports.isNotEmpty() && before.second != transports -> moved()
        }
    }
    fun close() { closed = true; runCatching { connectivity.unregisterNetworkCallback(callback) } }

    private companion object {
        val TRANSPORTS = listOf(NetworkCapabilities.TRANSPORT_WIFI, NetworkCapabilities.TRANSPORT_CELLULAR, NetworkCapabilities.TRANSPORT_ETHERNET)
    }
}
