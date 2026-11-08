# Private links between hosts

The application still listens on its root-only Unix socket. SSH forwards a separate local Unix socket to each remote application instance, over the private mesh. Neither host needs a TCP application listener. Installing these files does not start a service or alter the existing link configuration.

On each host, provision a root-only SSH key and verify the other host's SSH host key in root's known_hosts by a trusted route. The destination's sshd must permit root public-key login and Unix socket forwarding; restrict its authorized key to this use where practical. Both endpoints are root-trusted: a caller with access to a link socket can act as a person in a shared chat. Do not expose these sockets to other users or forward them over an untrusted host.

Run `sudo deploy/host-link/install`. For each remote instance create a distinct root-owned mode 0600 `/etc/kenan/link-forward/NAME.env`, for example:

```
REMOTE_HOST=kenan.example.com
REMOTE_SOCKET=/run/kenan/beta-link.sock
LOCAL_SOCKET=/run/kenan-link/other-beta.sock
IDENTITY_FILE=/root/.ssh/kenan-link
```

Use the actual configured remote `link.listen` socket, not the example path. Configure one instance for each remote app, even when both are named beta. `sudo systemctl enable --now kenan-link-forward@NAME.service` starts it; check its status and socket. Add its local socket to the local app's `link.siblings` when ready to use it. For traffic the other way, repeat on the other host, pointing at this app's socket. Restart the affected app after changing its configuration. Stop/disable the individual unit and remove its sibling entry to undo the link. No installation or activation is part of the host migration until its existing authorization is given.

The directory and forwarded sockets are root-only. SSH verifies the remote host key, allows ten seconds per connection attempt, reconnects after loss and removes its stale local socket on reconnect. Use mesh names in `REMOTE_HOST` so public address changes need no configuration update. The remote SSH server's `AllowStreamLocalForwarding` and filesystem permissions must permit connecting to the app socket. Use an individual key and narrowly scoped authorized-key policy on each peer; no private key or account credentials belong in the environment file.

## Application configuration

Every instance keeps a directory entry for every linked person it shares chats or agent messages with. Exactly one instance hosts a person's manager and workers; the other entries use `manager: {"elsewhere": "https://kenan.example.com"}`. Household `peers` entries name the person's id on both sides. Directory queries do not recurse: configure a direct sibling socket to every instance that should be discoverable.

Each shared chat has one owning database. Importing a person's data onto another host must not create a second active copy of the shared chat: keep it only on its selected owning host. The other application lists and accesses that chat over the link, including live events, human posts, Kenaznia posts and streamed attachments. The receiver fetches files through the private API rather than assuming filesystem paths exist on both machines.

Agent messages remain in `dataDir/link-outbox/PERSON` until the destination commits its pending input. A permanent database delivery key suppresses retries even after the input is consumed. Queued messages retain their instance's local socket name: preserve that alias if a peer changes hosts while messages remain outstanding. Broadcast membership records travel with deliveries; reply-all can resolve the original sender on the other host. A queued message for a worker that finished while offline goes to that worker's Kenaznia. Shared chat history remains in its owning database; live events are refreshed on stream reconnect.

To receive completions from jobs still running on the old host, configure `"forwardEvents": ["PERSON"]` inside `link` on exactly one old-host instance. The person must remain configured there with the original UID/GID and an elsewhere manager. Generic inbox draining accepts these explicitly selected remote owners; only `startHostInboxes` filters for locally hosted managers. Applying that filter again inside the drainer would silently strand forwarded events. That instance retains each event file until the destination records it; the destination uses the existing event idempotency key and immediately checks wakes. Disable this option once the old jobs have ended. Nothing in installation moves accounts, jobs, chats or hostnames.
