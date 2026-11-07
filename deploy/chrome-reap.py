#!/usr/bin/env python3
"""Stops headless automation Chrome browsers whose launcher has gone.

A Chrome started by agent-browser, Playwright or Puppeteer runs headless with a DevTools endpoint (a port or a pipe) and
only the program that launched it can drive it. When that program dies without closing it, the browser is reparented to
init or a systemd user manager and keeps its renderer, GPU and network processes running for good. This finds those
browsers and stops each one with every process under it.

agent-browser daemons are covered more directly: /etc/systemd/user/agent-browser-.service.d keeps their Chrome inside the
daemon's own service, so the daemon's exit stops it. This catches everything else (scripts, test runners, older daemons).

  kenan-chrome-reap [--dry-run] [--min-age SECONDS]

Installed as /usr/local/sbin/kenan-chrome-reap, run every 5 minutes as root by kenan-chrome-reap.timer (Kenan Stack deploy/).
"""
import argparse
import os
import signal
import sys
import time

BROWSER_NAMES = {"chrome", "chromium", "chromium-browser", "google-chrome", "headless_shell", "chrome-headless-shell"}
CLOCK_TICKS = os.sysconf("SC_CLK_TCK")


def read_procs():
    """pid -> {ppid, uid, comm, args, age}; processes that vanish while being read are skipped."""
    uptime = float(open("/proc/uptime").read().split()[0])
    procs = {}
    for entry in os.listdir("/proc"):
        if not entry.isdigit():
            continue
        try:
            with open(f"/proc/{entry}/stat") as f:
                stat = f.read()
            with open(f"/proc/{entry}/cmdline", "rb") as f:
                args = [a.decode(errors="replace") for a in f.read().split(b"\0") if a]
            if len(args) == 1:  # Chrome rewrites its command line as one space-separated string
                args = args[0].split(" ")
            uid = os.stat(f"/proc/{entry}").st_uid
        except OSError:
            continue
        # comm may contain spaces and parentheses; the fields after the last ')' are fixed.
        comm = stat[stat.index("(") + 1:stat.rindex(")")]
        fields = stat[stat.rindex(")") + 2:].split()
        procs[int(entry)] = {"ppid": int(fields[1]), "uid": uid, "comm": comm, "args": args,
                             "age": uptime - int(fields[19]) / CLOCK_TICKS}
    return procs


def is_automation_browser(args):
    """A Chrome browser process (not one of its helpers) that runs headless under a DevTools client."""
    if not args or os.path.basename(args[0]) not in BROWSER_NAMES:
        return False
    if any(a.startswith("--type=") for a in args):
        return False
    headless = any(a == "--headless" or a.startswith("--headless=") for a in args)
    driven = any(a.startswith("--remote-debugging-port") or a == "--remote-debugging-pipe" for a in args)
    return headless and driven


def orphaned(proc, procs):
    """Its launcher is gone: it now belongs to init or to a systemd (user) manager acting as subreaper."""
    if proc["ppid"] == 1:
        return True
    parent = procs.get(proc["ppid"])
    return parent is not None and parent["comm"] == "systemd"


def descendants(pid, procs):
    children = {}
    for child, p in procs.items():
        children.setdefault(p["ppid"], []).append(child)
    found, stack = [], [pid]
    while stack:
        for child in children.get(stack.pop(), []):
            found.append(child)
            stack.append(child)
    return found


def orphaned_browsers(procs, min_age):
    return [pid for pid, p in procs.items()
            if is_automation_browser(p["args"]) and orphaned(p, procs) and p["age"] >= min_age]


def signal_all(pids, sig):
    for pid in pids:
        try:
            os.kill(pid, sig)
        except ProcessLookupError:
            pass
        except PermissionError as error:
            print(f"cannot signal {pid}: {error}", file=sys.stderr)


def stop_tree(pid, procs, grace=5.0):
    tree = [pid] + descendants(pid, procs)
    signal_all([pid], signal.SIGTERM)  # Chrome shuts its own helpers down on SIGTERM.
    deadline = time.monotonic() + grace
    while time.monotonic() < deadline and any(os.path.exists(f"/proc/{p}") for p in tree):
        time.sleep(0.2)
    signal_all([p for p in tree if os.path.exists(f"/proc/{p}")], signal.SIGKILL)
    return len(tree)


def user_name(uid):
    try:
        import pwd
        return pwd.getpwuid(uid).pw_name
    except KeyError:
        return str(uid)


def main():
    parser = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    parser.add_argument("--dry-run", action="store_true", help="list what would be stopped")
    parser.add_argument("--min-age", type=float, default=120, help="seconds a browser must have run (default 120)")
    options = parser.parse_args()
    procs = read_procs()
    for pid in orphaned_browsers(procs, options.min_age):
        p = procs[pid]
        profile = next((a.split("=", 1)[1] for a in p["args"] if a.startswith("--user-data-dir=")), "?")
        what = f"orphaned headless Chrome {pid} of {user_name(p['uid'])}, {p['age'] / 60:.0f} min old, profile {profile}"
        if options.dry_run:
            print(f"would stop {what}")
        else:
            print(f"stopped {what} ({stop_tree(pid, procs)} processes)")


if __name__ == "__main__":
    main()
