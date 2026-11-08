#!/usr/bin/env python3
"""Run the native CLI, holding shared cloud-browser activity until it exits."""
import os
import sys


# Match native config precedence and skip values belonging to its other flags.
_VALUE_FLAGS = set("""--session --restore-save --restore-check-url --restore-check-text
--restore-check-fn --namespace --headers --executable-path --cdp --extension
--init-script --enable --profile --state --storage-state --proxy --proxy-bypass
--args --user-agent -p --provider --device --session-name --color-scheme
--download-path --max-output --allowed-domains --action-policy --confirm-actions
--engine --screenshot-dir --screenshot-quality --screenshot-format --idle-timeout
--ca-cert --model""".split())


def config_argument(args):
    index = 0
    while index < len(args):
        value = args[index]
        if value == "--config":
            return (args[index + 1] if index + 1 < len(args) else None), index
        if value.startswith("--config="):
            return value.split("=", 1)[1], index
        index += 2 if value in _VALUE_FLAGS else 1
    return os.environ.get("AGENT_BROWSER_CONFIG"), None


def native_binary():
    return os.environ.get("AGENT_BROWSER_BINARY") or os.path.join(os.path.dirname(os.path.realpath(__file__)), "agent-browser-native")


# Ordinary local commands need neither cloud locking nor a Python supervisor.
# Resolve config precedence before importing those modules on every CLI call.
if __name__ == "__main__" and (config_argument(sys.argv[1:])[0] is None or os.environ.get("AGENT_BROWSER_ACTIVITY_BYPASS") == "1"):
    binary = native_binary()
    try:
        os.execv(binary, [binary, *sys.argv[1:]])
    except OSError:
        print('{"success": false, "type": "cloud_activity_unavailable", "error": "Could not access the browser executable."}', flush=True)
        sys.exit(1)


import json
import signal
import subprocess

from activity import ActivityError, cloud_config, command_activity, touch


def error(code, message):
    print(json.dumps({"success": False, "type": code, "error": message}), flush=True)


def finish(status):
    if status < 0:
        number = -status
        signal.signal(number, signal.SIG_DFL)
        os.kill(os.getpid(), number)
    return status


def run_supervised(binary, args, config):
    """A small supervisor retains the lock even if the outer wrapper is killed.

    Native receives no lock fd, so its long-lived daemon cannot inherit one.
    waitpid tracks our actual child, without PID reuse or polling.
    """
    signals = (signal.SIGTERM, signal.SIGINT, signal.SIGHUP)
    old_handlers = {number: signal.getsignal(number) for number in signals}
    # Block signals across fork/handler setup, then restore the original mask.
    mask = signal.pthread_sigmask(signal.SIG_BLOCK, signals)
    supervisor = os.fork()
    if supervisor == 0:
        child = None
        pending = []

        def forward(number, _frame):
            if child is None:
                pending.append(number)
            else:
                try:
                    child.send_signal(number)
                except ProcessLookupError:
                    pass

        for number in signals:
            signal.signal(number, forward)
        signal.pthread_sigmask(signal.SIG_SETMASK, mask)
        status = 1
        try:
            child = subprocess.Popen([binary, *args], close_fds=True, restore_signals=True)
            for number in pending:
                child.send_signal(number)
            status = child.wait()
        except OSError:
            error("cloud_native_launch_failed", "Could not launch the native browser executable.")
        finally:
            try:
                touch(config)
            except (ActivityError, OSError):
                print("agent-browser: could not update cloud activity", file=sys.stderr, flush=True)
        if status < 0:
            finish(status)
        os._exit(status)

    def forward(number, _frame):
        try:
            os.kill(supervisor, number)
        except ProcessLookupError:
            pass

    for number in signals:
        signal.signal(number, forward)
    signal.pthread_sigmask(signal.SIG_SETMASK, mask)
    try:
        _, status = os.waitpid(supervisor, 0)
        return os.waitstatus_to_exitcode(status)
    finally:
        for number, handler in old_handlers.items():
            signal.signal(number, handler)


def main():
    args = sys.argv[1:]
    binary = native_binary()
    selected, index = config_argument(args)
    config = cloud_config(selected)
    if config is None or os.environ.get("AGENT_BROWSER_ACTIVITY_BYPASS") == "1":
        os.execv(binary, [binary, *args])
    # Native currently accepts only the separated spelling.
    if index is not None and args[index].startswith("--config="):
        args[index:index + 1] = ["--config", selected]
    with command_activity(config):
        if not config.is_file():
            error("cloud_session_ended", "The cloud browser config is gone; start or attach a live browser.")
            return 1
        status = run_supervised(binary, args, config)
    return finish(status)


if __name__ == "__main__":
    try:
        sys.exit(main())
    except ActivityError as failure:
        error(failure.code, str(failure))
        sys.exit(1)
    except OSError:
        error("cloud_activity_unavailable", "Could not access the browser executable or cloud activity files.")
        sys.exit(1)
