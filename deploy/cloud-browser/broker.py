"""Browser Use Cloud API broker: holds the API key, serves the cloud-browser client over a unix socket.

Each request is one JSON line {method, path, body}; the caller's uid comes from SO_PEERCRED. uid 1000 (kenan, Alice's
profiles) and root may do anything. Every other user may only use profiles named USER or USER-*, list and drive
browsers they started, and create profiles with such names. Key file: /etc/kenan/browser-use.key (root, 0600).
"""
import fnmatch, json, os, pwd, socketserver, struct, socket, threading, time, urllib.error, urllib.request
from pathlib import Path

API = "https://api.browser-use.com/api/v2"
SOCK = "/run/cloud-browser/broker.sock"
KEY = Path(os.environ.get("BROWSER_USE_KEY_FILE", "/etc/kenan/browser-use.key")).read_text().strip()
OWNERS_FILE = Path("/var/lib/cloud-browser/owners.json")
LOCK = threading.Lock()
OWNERS = json.loads(OWNERS_FILE.read_text()) if OWNERS_FILE.exists() else {}
PRIVILEGED = {0, *map(int, filter(None, os.environ.get("BROWSER_USE_PRIVILEGED_UIDS", "1000").split(",")))}

# Hosts may restrict identities to named profiles or patterns, with explicit exclusions.
ALLOWED = {user.strip(): [p.strip() for p in names.split(",") if p.strip()]
           for user, _, names in (entry.partition("=") for entry in os.environ.get("BROWSER_USE_ALLOWED_PROFILES", "").split(";") if "=" in entry)}

EXCLUDED = [p.strip() for p in os.environ.get("BROWSER_USE_EXCLUDED_PROFILES", "").split(",") if p.strip()]


class Denied(Exception):
    pass


def upstream(method, path, body=None):
    request = urllib.request.Request(API + path, method=method, data=None if body is None else json.dumps(body).encode(),
                                     headers={"X-Browser-Use-API-Key": KEY, "Content-Type": "application/json"})
    try:
        with urllib.request.urlopen(request, timeout=60) as response:
            raw = response.read()
            return response.status, json.loads(raw) if raw else {}
    except urllib.error.HTTPError as error:
        raw = error.read().decode(errors="replace")
        try:
            detail = json.loads(raw)
        except ValueError:
            detail = {"error": raw}
        return error.code, detail


def own_name(user, name):
    if not isinstance(name, str) or any(fnmatch.fnmatchcase(name, p) for p in EXCLUDED):
        return False
    if user in ALLOWED:
        return any(fnmatch.fnmatchcase(name, p) for p in ALLOWED[user])
    return name == user or name.startswith(user + "-")


def profile_name(profile_id):
    status, found = upstream("GET", f"/profiles/{profile_id}")
    return found.get("name") if status == 200 else None


def save_owner(session, user):
    with LOCK:
        OWNERS[session] = user
        OWNERS_FILE.parent.mkdir(parents=True, exist_ok=True)
        OWNERS_FILE.write_text(json.dumps(OWNERS))


def handle(uid, method, path, body, remote_user=None):
    if remote_user is not None and uid != 0:
        raise Denied("remote identity requires root")
    if (remote_user is None and uid in PRIVILEGED) or remote_user in ("root", "kenan"):
        status, out = upstream(method, path, body)
        if method == "POST" and path == "/browsers" and status < 300 and "id" in out:
            save_owner(out["id"], "kenan")
        return status, out
    user = remote_user if remote_user is not None else pwd.getpwuid(uid).pw_name
    route = path.split("?")[0].strip("/").split("/")
    if route == ["billing", "account"] and method == "GET":
        status, out = upstream(method, path)
        return status, {k: out.get(k) for k in ("totalCreditsBalanceUsd", "activeSessionCount", "concurrentSessionLimit")}
    if route == ["profiles"] and method == "GET":
        status, out = upstream(method, path)
        if status == 200:
            out["items"] = [p for p in out["items"] if own_name(user, p["name"])]
            out["totalItems"] = len(out["items"])
        return status, out
    if route == ["profiles"] and method == "POST":
        if not own_name(user, (body or {}).get("name", "")):
            raise Denied(f"profile names for {user} must be {user} or {user}-NAME")
        return upstream(method, path, {"name": body["name"]})
    if route == ["browsers"] and method == "POST":
        body = dict(body or {})
        if "profileId" not in body and user in ALLOWED:
            raise Denied(f"{user} may only start a browser on one of its profiles: {', '.join(ALLOWED[user])}")
        if "profileId" in body:
            name = profile_name(body["profileId"])
            if name is None or not own_name(user, name):
                raise Denied(f"profile is not yours; {user} may use profiles named {user} or {user}-NAME")
        status, out = upstream(method, path, body)
        if status < 300 and "id" in out:
            save_owner(out["id"], user)
        return status, out
    if route == ["browsers"] and method == "GET":
        status, out = upstream(method, path)
        if status == 200:
            out["items"] = [b for b in out["items"] if OWNERS.get(b["id"]) == user]
        return status, out
    if len(route) == 2 and route[0] == "browsers" and method in ("GET", "PATCH"):
        if OWNERS.get(route[1]) != user:
            raise Denied("that browser session is not yours")
        if method == "PATCH":
            body = {"action": "stop"} if (body or {}).get("action") == "stop" else (_ for _ in ()).throw(Denied("only stop is allowed"))
        return upstream(method, path, body)
    if len(route) == 3 and route[0] == "browsers" and route[2] == "downloads" and method == "GET":
        if OWNERS.get(route[1]) != user:
            raise Denied("that browser session is not yours")
        return upstream(method, path)
    if len(route) == 4 and route[:2] == ["files", "browsers"] and route[3] == "presigned-url" and method == "POST":
        if OWNERS.get(route[2]) != user:
            raise Denied("that browser session is not yours")
        return upstream(method, path, body)
    raise Denied(f"{method} {path} is not available to {user}")


class Handler(socketserver.StreamRequestHandler):
    def handle(self):
        uid = struct.unpack("3i", self.request.getsockopt(socket.SOL_SOCKET, socket.SO_PEERCRED, struct.calcsize("3i")))[1]
        try:
            req = json.loads(self.rfile.readline(1 << 20))
            status, out = handle(uid, req["method"], req["path"], req.get("body"), req.get("remote_user"))
            reply = {"status": status, "body": out}
        except Denied as error:
            reply = {"status": 403, "body": {"error": f"denied: {error}"}}
        except Exception as error:
            reply = {"status": 500, "body": {"error": f"broker: {error}"}}
        self.wfile.write(json.dumps(reply).encode() + b"\n")


MAX_PROXY_MB = float(os.environ.get("BROWSER_USE_MAX_PROXY_MB", "400"))


def reap_forever():
    """Backstop for every caller on every host: stop a browser that has pulled more than MAX_PROXY_MB through the paid residential
    proxy (about $2 at $5/GB). Idle and end-of-turn stops live in the Kenan Stack; a looping page, a stuck agent or a script
    that never stops its browser is what this catches. Stopping saves the profile.
    """
    while True:
        time.sleep(30)
        try:
            status, out = upstream("GET", "/browsers?pageSize=100&filterBy=active")
            for browser in out.get("items", []) if status == 200 else []:
                if float(browser.get("proxyUsedMb") or 0) > MAX_PROXY_MB:
                    upstream("PATCH", f"/browsers/{browser['id']}", {"action": "stop"})
                    print(json.dumps({"type": "proxy_cap_stop", "session": browser["id"], "owner": OWNERS.get(browser["id"]), "mb": browser["proxyUsedMb"]}), flush=True)
        except Exception as error:
            print(json.dumps({"type": "reaper_error", "error": str(error)}), flush=True)


class Server(socketserver.ThreadingMixIn, socketserver.UnixStreamServer):
    daemon_threads = True


if __name__ == "__main__":
    Path(SOCK).unlink(missing_ok=True)
    threading.Thread(target=reap_forever, daemon=True).start()
    with Server(SOCK, Handler) as server:
        os.chmod(SOCK, 0o666)
        server.serve_forever()
