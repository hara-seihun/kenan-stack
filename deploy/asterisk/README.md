# Asterisk configuration and media-source changes

`configure.py` owns the SIP/ARI configuration and carrier firewall. Its normal apply path also installs `install-media.py` and `negotiated-media-learning.patch` on every Asterisk host it manages. `--check` does not change Asterisk configuration or modules.

## Strict RTP fix

Asterisk 22.5.2 accepts SSRC, sequence and timestamp resets at the same source. It also accepts a source change when reINVITE changes the SDP address. But a transfer can retain the same SDP address while RTP actually moves to another source port. Stock Asterisk never reopens learning then: all 350 packets over seven seconds were dropped, despite `rtp_symmetric=yes`.

The patch reopens normal strict-RTP learning in the RTP engine's activation callback. PJSIP calls that callback after successfully applying negotiated SDP and capabilities. It is not called by RTP packets, symmetric-address updates, timers or SIP OPTIONS. The only other caller is the initial activation of a UnicastRTP channel. ICE keeps its existing nomination/learning behavior. The remote-address setter is unchanged.

The local-only reproduction now receives 346/350 packets after same-SDP reINVITE, starting at 80 ms: the first four packets satisfy the existing sequence probation. Without reINVITE, a changed source is still rejected, 0/350. Strict RTP stays enabled with `strictrtp=seqno`.

## Install and upgrades

Run as root on the Ubuntu amd64 Asterisk host:

```sh
python3 deploy/asterisk/install-media.py build   # prepare without changing the running service
python3 deploy/asterisk/install-media.py apply   # refuse active calls, install and restart
```

The installer compiles only `res_rtp_asterisk.so`, from the Ubuntu source matching the installed Asterisk package and that package's development headers. PJPROJECT uses Asterisk's bundled configuration. Sources, the built module and its package version live in `/var/cache/kenan/asterisk-media`. Unchanged builds return immediately.

Maintained files are installed in `/usr/local/lib/kenan/asterisk-media`. The systemd drop-in `/etc/systemd/system/asterisk.service.d/media-learning.conf` rebuilds and installs before every start. The apt hook `/etc/apt/apt.conf.d/99kenan-asterisk-media` starts an asynchronous refresh after package operations, outside apt's package lock. An upgrade replaces the on-disk module atomically; active calls retain their mapped module without a restart, and the next Asterisk process gets the matching patched build. No package diversion keeps an old-ABI module across upgrades. When idle, the upgrade refresh restarts immediately. Build/install failures remain visible in the systemd job or startup journal.

Rollback, with no active calls:

```sh
python3 /usr/local/lib/kenan/asterisk-media/install-media.py uninstall
```

That removes both hooks, reinstalls the current package's original module and restarts Asterisk.

## Direct local check

Run `python3 deploy/asterisk/reproduce-media-switch.py` as root on the phone edge. It creates a temporary loopback-only endpoint using the existing `pjsip_local.conf` include, calls it directly into Echo(), and sends RTP to Asterisk from two local sockets. It does not dial any outside number or touch a trunk, inbound route or phone global. It removes the endpoint on exit. If that optional include is already occupied, choose another isolated include rather than replacing its contents.

Output shows packet counts for initial traffic, unannounced source migration and the same-SDP reINVITE. This is a direct diagnostic, not an installation gate. It checks the transport behavior; it does not establish whether a particular outside call changed source tuples.
