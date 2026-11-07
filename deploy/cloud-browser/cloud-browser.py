"""Browser Use Cloud browsers for agents (US residential egress, profiles that keep logins).

`start PROFILE`, `attach SESSION` and `stop SESSION` print one JSON
line; start/attach write an owner-only agent-browser config (the person's ~/.agent-browser defaults plus the CDP
endpoint) to /run/user/UID/cloud-browser/SESSION.json, which `agent-browser --config FILE` attaches to.
The API key stays in the root-owned broker (broker.py); this client talks to it over a unix socket. CDP and live-view URLs are secrets: never log them.
"""
import argparse, json, os, subprocess, sys, tempfile, time
from pathlib import Path

from activity import ActivityError, command_activity, read_consumers, stop_activity

API = "https://api.browser-use.com/api/v2"
class Failure(Exception):
    pass


class ApiFailure(Failure):
    def __init__(self, status, body):
        self.status, self.body = status, body
        super().__init__(f"http_{status}: {json.dumps(body, ensure_ascii=False)}")


def run_dir():
    """The one place configs live, which the Kenan Stack browser tool also reads: the user's /run/user/UID."""
    run = Path(f"/run/user/{os.getuid()}")
    if not os.access(run, os.W_OK):
        raise Failure(f"no_runtime_dir: {run} is missing; every Kenan person lingers (sudo loginctl enable-linger {os.getuid()}, or sudo systemctl start kenan-user-grants-run)")
    return run


def write_private(path, text):
    path.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
    fd, temporary = tempfile.mkstemp(prefix=".config-", dir=path.parent)
    try:
        with os.fdopen(fd, "w") as file:
            file.write(text)
        os.replace(temporary, path)
    finally:
        Path(temporary).unlink(missing_ok=True)


SOCK = "/run/cloud-browser/broker.sock"


def call(method, path, body=None):
    import socket
    sock = socket.socket(socket.AF_UNIX)
    sock.settimeout(90)
    try:
        # systemd starts the process before its socket is bound. Retry only
        # connection setup during a restart, never a request already sent.
        import time
        for attempt in range(20):
            try:
                sock.connect(SOCK)
                break
            except (FileNotFoundError, ConnectionRefusedError):
                if attempt == 19:
                    raise
                time.sleep(0.05)
        sock.sendall(json.dumps({"method": method, "path": path, "body": body}).encode() + b"\n")
        raw = b""
        while not raw.endswith(b"\n"):
            chunk = sock.recv(65536)
            if not chunk:
                break
            raw += chunk
    except OSError as error:
        raise Failure(f"broker_unreachable: {error}; check systemctl status cloud-browser-broker") from None
    finally:
        sock.close()
    reply = json.loads(raw)
    if reply["status"] >= 300:
        raise ApiFailure(reply["status"], reply["body"])
    return reply["body"]


def profiles():
    found, page = [], 1
    while True:
        listed = call("GET", f"/profiles?pageSize=100&pageNumber={page}")
        found += listed["items"]
        if page * 100 >= listed["totalItems"]:
            return found
        page += 1


def profile_id(name):
    for profile in profiles():
        if name in (profile["id"], profile["name"]):
            return profile["id"]
    raise Failure(f"profile_not_found: no Browser Use profile named {name!r} (cloud-browser profiles; create with cloud-browser profile-create NAME)")


def config_path(session):
    return run_dir() / "cloud-browser" / f"{session}.json"


def user_defaults():
    path = Path.home() / ".agent-browser" / "config.json"
    if not path.exists():
        return {}
    defaults = json.loads(path.read_text())
    if not isinstance(defaults, dict):
        raise Failure(f"{path} must hold a JSON object")
    return defaults


def _save_config(browser):
    if browser.get("status") != "active" or not browser.get("cdpUrl"):
        raise Failure(f"session_not_active: {browser['id']} is {browser.get('status')}")
    write_private(config_path(browser["id"]), json.dumps({**user_defaults(), "cdp": browser["cdpUrl"]}))
    return {"session_id": browser["id"], "config_path": str(config_path(browser["id"])), "live_view_url": browser.get("liveUrl"),
            "ends_at": browser.get("timeoutAt")}


def save_config(browser, keep_alive_minutes=None):
    with command_activity(config_path(browser["id"]), keep_alive_minutes):
        return _save_config(browser)


def attach_browser(session, keep_alive_minutes=None):
    # Fetch and write within one lock: stop must not accept the provider's
    # stop request between the active-status read and config replacement.
    with command_activity(config_path(session), keep_alive_minutes):
        return _save_config(call("GET", f"/browsers/{session}"))


def stop_browser(session, idle_before=None):
    config = config_path(session)
    deferred = {"session_id": session, "stopped": False, "reason": "session_in_use"}
    with stop_activity(config) as lock:
        if lock is None:
            return deferred
        if idle_before is not None and any(record["lastUsedAt"] >= idle_before for record in read_consumers(config)):
            return deferred
        output = summary(call("PATCH", f"/browsers/{session}", {"action": "stop"}))
        # Only disconnect our daemon after the provider accepts the stop.
        # It must not reacquire SH while this process holds EX.
        environment = {**os.environ, "AGENT_BROWSER_ACTIVITY_BYPASS": "1"}
        try:
            subprocess.run(["agent-browser", "--session", f"cloud-{session}", "close"],
                           env=environment, capture_output=True, timeout=20)
        except (FileNotFoundError, PermissionError, subprocess.TimeoutExpired):
            pass
        stop_media_guard(session)
        config.unlink(missing_ok=True)
        return {**output, "session_id": session, "stopped": True}


def upload(session, local_file, selector, target_id=None):
    with command_activity(config_path(session)):
        return _upload(session, local_file, selector, target_id)


PROXY_FAILURES = ("ERR_SOCKS_CONNECTION_FAILED", "ERR_SOCKS_CONNECTION_HOST_UNREACHABLE",
                  "ERR_PROXY_CONNECTION_FAILED", "ERR_TUNNEL_CONNECTION_FAILED")


def proxy_route_error(browser):
    """Check the provider's new proxy before handing a session to an agent.

    The disposable tab has no application state. Only a proxy handshake failure
    permits replacement; application actions in an existing browser are never replayed.
    Uses the asyncio client, which every websockets release has (Debian 12 ships 10.4,
    without websockets.sync: `start` failed with ModuleNotFoundError on 2026-11-04).
    """
    import asyncio
    import urllib.request
    import websockets
    cdp = browser["cdpUrl"]
    if cdp.startswith("http"):
        cdp = json.load(urllib.request.urlopen(cdp.rstrip("/") + "/json/version", timeout=20))["webSocketDebuggerUrl"]

    async def probe():
        async with websockets.connect(cdp, max_size=None, open_timeout=20) as ws:
            counter = iter(range(1, 1000000))
            async def send(method, params=None, sid=None):
                number = next(counter)
                await ws.send(json.dumps({"id": number, "method": method, "params": params or {},
                                          **({"sessionId": sid} if sid else {})}))
                while True:
                    reply = json.loads(await asyncio.wait_for(ws.recv(), timeout=20))
                    if reply.get("id") == number:
                        if "error" in reply:
                            raise Failure(f"proxy_check_failed: {reply['error']['message']}")
                        return reply.get("result", {})
            target = (await send("Target.createTarget", {"url": "about:blank"}))["targetId"]
            try:
                sid = (await send("Target.attachToTarget", {"targetId": target, "flatten": True}))["sessionId"]
                result = await send("Page.navigate", {"url": "https://example.com/"}, sid)
                error = result.get("errorText", "")
                return error if any(name in error for name in PROXY_FAILURES) else None
            finally:
                await send("Target.closeTarget", {"targetId": target})
    return asyncio.run(probe())

BLOCKED_TYPES = ("Image", "Media", "Font")


def guard_pid_file(session):
    return config_path(session).with_suffix(".media-guard.pid")


def guard_running(session):
    try:
        pid = int(guard_pid_file(session).read_text())
        os.kill(pid, 0)
        return pid
    except (OSError, ValueError):
        return None


def start_media_guard(session):
    """Detach the sidecar that drops image, video, audio and font requests in this session's pages."""
    if guard_running(session):
        return
    subprocess.Popen([sys.executable, os.path.abspath(__file__), "_media-guard", session], stdin=subprocess.DEVNULL,
                     stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, start_new_session=True)
    for _ in range(50):  # ready once it has written its pid, i.e. is attached to the browser
        if guard_running(session):
            return
        time.sleep(0.1)


def stop_media_guard(session):
    pid = guard_running(session)
    if pid:
        try:
            os.kill(pid, 15)
        except OSError:
            pass
    guard_pid_file(session).unlink(missing_ok=True)
    return pid is not None


def media_guard(session):
    """Residential proxy bandwidth is what Browser Use bills, and images, video and fonts are most of it (a page of text is
    tens of KB; its pictures are megabytes). This second CDP client auto-attaches to every page, pauses each request of a
    blocked type before it is sent and fails it. It runs until the browser ends, the config is removed, or `media allow`.
    """
    import asyncio
    import urllib.request
    import websockets
    config = config_path(session)
    cdp = json.loads(config.read_text())["cdp"]
    if cdp.startswith("http"):
        cdp = json.load(urllib.request.urlopen(cdp.rstrip("/") + "/json/version", timeout=20))["webSocketDebuggerUrl"]
    pid_file = guard_pid_file(session)
    patterns = [{"urlPattern": "*", "resourceType": kind} for kind in BLOCKED_TYPES]

    async def run():
        async with websockets.connect(cdp, max_size=None, open_timeout=30, ping_interval=20) as ws:
            counter = iter(range(1, 10**9))
            async def send(method, params=None, sid=None):
                await ws.send(json.dumps({"id": next(counter), "method": method, "params": params or {}, **({"sessionId": sid} if sid else {})}))
            async def watch_config():
                while config.exists():
                    await asyncio.sleep(5)
                await ws.close()
            watcher = asyncio.create_task(watch_config())
            auto = {"autoAttach": True, "waitForDebuggerOnStart": True, "flatten": True}
            await send("Target.setAutoAttach", auto)
            await send("Target.setDiscoverTargets", {"discover": True})
            pid_file.write_text(str(os.getpid()))
            seen = set()
            try:
                async for raw in ws:
                    message = json.loads(raw)
                    method, params, sid = message.get("method"), message.get("params", {}), message.get("sessionId")
                    if method == "Target.attachedToTarget":
                        child = params["sessionId"]
                        await send("Fetch.enable", {"patterns": patterns}, child)
                        await send("Target.setAutoAttach", auto, child)
                        if params.get("waitingForDebugger"):
                            await send("Runtime.runIfWaitingForDebugger", {}, child)
                    elif method == "Target.targetCreated":
                        info = params["targetInfo"]
                        if info["type"] == "page" and info["targetId"] not in seen:
                            seen.add(info["targetId"])
                            await send("Target.attachToTarget", {"targetId": info["targetId"], "flatten": True})
                    elif method == "Fetch.requestPaused":
                        await send("Fetch.failRequest", {"requestId": params["requestId"], "errorReason": "BlockedByClient"}, sid)
            finally:
                watcher.cancel()
    try:
        asyncio.run(run())
    finally:
        pid_file.unlink(missing_ok=True)


def start_browser(body, keep_alive_minutes=None, images=False):
    for attempt in range(2):
        browser = call("POST", "/browsers", body)
        with command_activity(config_path(browser["id"]), keep_alive_minutes):
            try:
                error = proxy_route_error(browser) if body.get("proxyCountryCode") else None
                if not error:
                    saved = _save_config(browser)
                    if not images:
                        start_media_guard(browser["id"])
                    return saved
            except Exception:
                call("PATCH", f"/browsers/{browser['id']}", {"action": "stop"})
                raise
            call("PATCH", f"/browsers/{browser['id']}", {"action": "stop"})
        if attempt == 1:
            raise Failure(f"proxy_route_unavailable: fresh residential routes failed ({error}); both unused browsers stopped")
        print(f"cloud-browser: provider proxy failed ({error}); replacing unused session", file=sys.stderr)


def _upload(session, local_file, selector, target_id=None):
    """Transfer local bytes through CDP and select a File with its original name and MIME.

    Chunks avoid a large protocol message or reading the entire file into local memory.
    This bypasses the provider's restricted presigned file service, not the destination's limits.
    """
    import asyncio, base64, mimetypes, urllib.request
    import websockets
    path = Path(local_file).expanduser()
    if not path.is_file():
        raise Failure(f"no_such_file: {path}")
    kind = mimetypes.guess_type(path.name)[0] or "application/octet-stream"
    cdp = json.loads(config_path(session).read_text())["cdp"]
    if cdp.startswith("http"):
        cdp = json.load(urllib.request.urlopen(cdp.rstrip("/") + "/json/version", timeout=20))["webSocketDebuggerUrl"]
    async def transfer():
        async with websockets.connect(cdp, max_size=None, open_timeout=30) as ws:
            with path.open("rb") as file:
                counter = iter(range(1, 10**9))
                async def send(method, params=None, sid=None):
                    number = next(counter)
                    await ws.send(json.dumps({"id": number, "method": method, "params": params or {}, **({"sessionId": sid} if sid else {})}))
                    while True:
                        reply = json.loads(await asyncio.wait_for(ws.recv(), timeout=30))
                        if reply.get("id") == number:
                            if "error" in reply:
                                raise Failure(f"cdp_{method}: {reply['error']['message']}")
                            result = reply.get("result", {})
                            if "exceptionDetails" in result:
                                detail = result["exceptionDetails"]
                                raise Failure(f"cdp_{method}: {detail.get('exception', {}).get('description', detail.get('text'))}")
                            return result
                pages = [t for t in (await send("Target.getTargets"))["targetInfos"] if t["type"] == "page" and not t["url"].startswith(("devtools:", "chrome-extension:"))]
                if not pages:
                    raise Failure("no_page: the browser has no open tab")
                if target_id:
                    matches = [page for page in pages if page["targetId"] == target_id]
                    if not matches:
                        raise Failure("target_missing: the selected upload tab is no longer open")
                    page = matches[0]
                elif len(pages) == 1:
                    page = pages[0]
                else:
                    raise Failure("target_required: more than one tab is open; pass --target with its targetId from agent-browser tab --json")
                sid = (await send("Target.attachToTarget", {"targetId": page["targetId"], "flatten": True}))["sessionId"]
                frame = (await send("Page.getFrameTree", sid=sid))["frameTree"]["frame"]["id"]
                context = (await send("Page.createIsolatedWorld", {
                    "frameId": frame, "worldName": "cloud-browser-upload"}, sid))["executionContextId"]
                # Match native CSS lookup: document first, then nested open roots.
                # An isolated world avoids page-patched DOM APIs hiding controls.
                result = (await send("Runtime.evaluate", {"contextId": context,
                    "expression": """(() => {
                        const selector = %s;
                        const find = root => {
                            const direct = root.querySelector(selector);
                            if (direct) return direct;
                            for (const host of root.querySelectorAll('*')) {
                                if (!host.shadowRoot) continue;
                                const match = find(host.shadowRoot);
                                if (match) return match;
                            }
                            return null;
                        };
                        return find(document);
                    })()""" % json.dumps(selector)}, sid))["result"]
                target = result.get("objectId")
                if not target:
                    raise Failure(f"no_input: nothing matches {selector!r} in {page['url']} (a file input inside an iframe is not reachable)")
                parts = None
                size = 0
                try:
                    parts = (await send("Runtime.callFunctionOn", {"objectId": target, "functionDeclaration": """function() {
                        if (!(this instanceof HTMLInputElement) || this.type !== 'file')
                            throw new Error('upload target must be an input[type=file]');
                        return [];
                    }"""}, sid))["result"]["objectId"]
                    while chunk := file.read(768 * 1024):
                        await send("Runtime.callFunctionOn", {"objectId": parts,
                            "functionDeclaration": "function(chunk) { this.push(Uint8Array.from(atob(chunk), c => c.charCodeAt(0))); }",
                            "arguments": [{"value": base64.b64encode(chunk).decode()}]}, sid)
                        size += len(chunk)
                    await send("Runtime.callFunctionOn", {"objectId": target, "functionDeclaration": """function(parts, name, type) {
                        if (!this.isConnected || this.type !== 'file') throw new Error('upload input changed during transfer');
                        const transfer = new DataTransfer();
                        transfer.items.add(new File(parts, name, {type}));
                        this.files = transfer.files;
                        this.dispatchEvent(new Event('input', {bubbles: true, composed: true}));
                        this.dispatchEvent(new Event('change', {bubbles: true}));
                    }""", "arguments": [{"objectId": parts}, {"value": path.name}, {"value": kind}]}, sid)
                finally:
                    # Do not mask an uncertain input dispatch with a cleanup failure or replay it.
                    for object_id in (parts, target):
                        if object_id:
                            try:
                                await send("Runtime.releaseObject", {"objectId": object_id}, sid)
                            except Exception:
                                pass
        return {"uploaded": path.name, "size_bytes": size, "mime_type": kind, "selector": selector, "tab": page["url"]}

    return asyncio.run(transfer())


def downloads(session, include_urls=False):
    """Read completed browser files, without revisiting their originating pages."""
    from urllib.parse import urlencode
    files, cursor = [], None
    while True:
        query = {"includeUrls": str(include_urls).lower()}
        if cursor:
            query["cursor"] = cursor
        result = call("GET", f"/browsers/{session}/downloads?{urlencode(query)}")
        files.extend(result["files"])
        cursor = result.get("nextCursor")
        if not result.get("hasMore"):
            return files
        if not cursor:
            raise Failure("download_list_incomplete: provider omitted the next cursor")


def download(session, name, destination):
    """Recover exactly one completed file; never replay a website request."""
    import tempfile
    import urllib.request
    found = [f for f in downloads(session, include_urls=True) if f["path"] == name]
    if not found:
        raise Failure("download_not_found: use cloud-browser downloads SESSION for completed file names")
    if len(found) != 1:
        raise Failure("download_ambiguous: provider returned multiple files with that name")
    item = found[0]
    if not item.get("url"):
        raise Failure("download_url_missing: provider did not return a completed-file URL")
    destination = Path(destination).expanduser().absolute()
    destination.parent.mkdir(parents=True, exist_ok=True)
    staging = None
    try:
        with tempfile.NamedTemporaryFile(prefix=".cloud-browser-", suffix=".part", dir=destination.parent, delete=False) as output:
            staging = Path(output.name)
            size = 0
            with urllib.request.urlopen(item["url"], timeout=30) as response:
                while chunk := response.read(1024 * 1024):
                    size += len(chunk)
                    output.write(chunk)
            if size != item["size"]:
                raise Failure("download_size_mismatch: completed file transfer was incomplete")
            output.flush()
            os.fsync(output.fileno())
        staging.replace(destination)
    finally:
        if staging:
            staging.unlink(missing_ok=True)
    return {"path": str(destination), "filename": name, "size_bytes": size}


def summary(browser):
    return {key: browser.get(key) for key in ("id", "status", "startedAt", "timeoutAt", "finishedAt", "browserCost", "proxyCost")}


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    commands = parser.add_subparsers(dest="command", required=True)
    start = commands.add_parser("start", help="Start a browser on a profile (logins persist when it stops) and save an agent-browser config")
    start.add_argument("profile", help='profile name or id; none for a throwaway browser')
    start.add_argument("--minutes", type=int, default=30, help="hard lifetime, at most 240; billed per hour started, unused time refunded on stop")
    start.add_argument("--country", default="us", help="residential proxy country code; none = no proxy (for sites that refuse it, e.g. cloud.browser-use.com)")
    start.add_argument("--keep-alive", type=int, choices=range(1, 241), metavar="MINUTES", help="consumer idle timeout, 1..240 minutes")
    start.add_argument("--http-request-budget", type=int, help="Require a literal HTTP dispatch cap; currently refused before any provider effect")
    start.add_argument("--images", action="store_true", help="load images, video and fonts (blocked by default: they are most of the proxy bandwidth bill); only for captchas, ID checks and pages that are unreadable without pictures")
    attach = commands.add_parser("attach", help="Save connection config for a live browser")
    attach.add_argument("session")
    attach.add_argument("--keep-alive", type=int, choices=range(1, 241), metavar="MINUTES", help="consumer idle timeout, 1..240 minutes")
    attach.add_argument("--http-request-budget", type=int, help="Require a literal HTTP dispatch cap; currently refused before any provider lookup")
    stop = commands.add_parser("stop", help="Stop an unused browser (saves its profile) and remove its config")
    stop.add_argument("session")
    stop.add_argument("--idle-before", type=int, metavar="MILLISECONDS", help="stop only if no consumer was used after this epoch timestamp")
    media = commands.add_parser("media", help="Block or allow images, video and fonts on a live session (blocked by default; allow only for a captcha or ID check, then block again)")
    media.add_argument("session")
    media.add_argument("mode", choices=("allow", "block"))
    commands.add_parser("_media-guard").add_argument("session")
    up = commands.add_parser("upload", help="Attach a local file (original name and bytes) to a selected tab file input")
    up.add_argument("session")
    up.add_argument("file")
    up.add_argument("--target", help="CDP targetId; required when more than one tab is open")
    up.add_argument("--selector", default="input[type=file]", help="CSS selector of the file input (default: the first one)")
    listing = commands.add_parser("downloads", help="List completed session files without repeating a website request")
    listing.add_argument("session")
    recovery = commands.add_parser("download", help="Save a named completed session file to local disk, including after a browser command timed out")
    recovery.add_argument("session")
    recovery.add_argument("name", help="Exact path returned by downloads")
    recovery.add_argument("destination")
    commands.add_parser("list", help="Active browsers")
    commands.add_parser("profiles", help="Saved profiles")
    commands.add_parser("profile-create", help="Create an empty profile").add_argument("name")
    commands.add_parser("balance", help="Credit balance and concurrency")
    args = parser.parse_args()
    if getattr(args, 'http_request_budget', None) is not None:
        # Fetch interception releases requests on disconnect and misses native
        # HTTP/2 retries. Never create/contact a cloud session under a false cap.
        print(json.dumps({'success': False, 'type': 'BUDGET_ENFORCEMENT_UNAVAILABLE',
                          'error': 'Managed residential cloud HTTP dispatch budgets are not supported. No provider lookup, session creation or navigation was performed.'}))
        return 1
    if args.command == "start":
        if not 1 <= args.minutes <= 240:
            raise Failure("--minutes must be 1..240")
        body = {"proxyCountryCode": None if args.country == "none" else args.country, "timeout": args.minutes, "browserScreenWidth": 1280, "browserScreenHeight": 900}
        if args.profile != "none":
            body["profileId"] = profile_id(args.profile)
        output = start_browser(body, args.keep_alive, args.images)
    elif args.command == "_media-guard":
        media_guard(args.session)
        return 0
    elif args.command == "media":
        if not config_path(args.session).exists():
            raise Failure(f"session_not_active: no config for {args.session}; start or attach it first")
        if args.mode == "allow":
            output = {"session_id": args.session, "media": "allowed", "guard_stopped": stop_media_guard(args.session)}
        else:
            start_media_guard(args.session)
            output = {"session_id": args.session, "media": "blocked"}
    elif args.command == "attach":
        output = attach_browser(args.session, args.keep_alive)
    elif args.command == "stop":
        output = stop_browser(args.session, args.idle_before)
    elif args.command == "upload":
        output = upload(args.session, args.file, args.selector, args.target)
    elif args.command == "downloads":
        output = [{k: f.get(k) for k in ("path", "size", "lastModified")} for f in downloads(args.session)]
    elif args.command == "download":
        output = download(args.session, args.name, args.destination)
    elif args.command == "list":
        output = [summary(browser) for browser in call("GET", "/browsers?pageSize=100&filterBy=active")["items"]]
    elif args.command == "profiles":
        output = [{key: profile.get(key) for key in ("id", "name", "lastUsedAt", "cookieDomains")} for profile in profiles()]
    elif args.command == "profile-create":
        output = call("POST", "/profiles", {"name": args.name})
    else:
        account = call("GET", "/billing/account")
        output = {key: account[key] for key in ("totalCreditsBalanceUsd", "activeSessionCount", "concurrentSessionLimit")}
    print(json.dumps(output))


if __name__ == "__main__":
    try:
        sys.exit(main())
    except ActivityError as error:
        print(json.dumps({"success": False, "type": error.code, "error": str(error)}))
        sys.exit(1)
    except (Failure, OSError, ValueError, KeyError) as error:
        print(f"cloud-browser: {error}", file=sys.stderr)
        sys.exit(1)
