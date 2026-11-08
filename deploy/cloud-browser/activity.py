"""Shared cloud-browser use records and nonblocking command/stop locks.

The lock file is permanent: removing it would let callers lock different inodes.
Only configs in the caller's canonical runtime directory are cloud configs.
"""
import fcntl
import json
import math
import os
import tempfile
import time
from contextlib import contextmanager
from pathlib import Path
from urllib.parse import quote
from uuid import UUID


class ActivityError(Exception):
    code = "cloud_activity_error"


class SessionStopping(ActivityError):
    code = "cloud_session_stopping"

    def __init__(self):
        super().__init__("The cloud browser is stopping; the command was not run.")


def cloud_config(path):
    """Return a recognized config Path, or None for every non-cloud path."""
    if not path:
        return None
    path = Path(os.path.abspath(os.path.expanduser(str(path))))
    root = Path(f"/run/user/{os.getuid()}/cloud-browser")
    if path.parent != root or path.suffix != ".json":
        return None
    try:
        if str(UUID(path.stem)) != path.stem:
            return None
    except ValueError:
        return None
    return path


def activity_dir(config):
    config = cloud_config(config)
    if config is None:
        raise ActivityError("Expected a cloud-browser runtime config.")
    return config.with_suffix(".activity")


def read_consumers(config):
    """Read consumer records. Invalid records fail rather than permit idle stop."""
    records = []
    for path in sorted(activity_dir(config).glob("*.json")):
        try:
            record = json.loads(path.read_text())
            if not isinstance(record, dict):
                raise ValueError("expected an object")
            agent = record["agentId"]
            used = record["lastUsedAt"]
            keep = record.get("keepAliveMinutes")
            if agent is not None and not isinstance(agent, str):
                raise ValueError("invalid agentId")
            if isinstance(used, bool) or not isinstance(used, (int, float)) or not math.isfinite(used) or used < 0:
                raise ValueError("invalid lastUsedAt")
            if keep is not None and (isinstance(keep, bool) or not isinstance(keep, (int, float)) or not math.isfinite(keep) or not 1 <= keep <= 240):
                raise ValueError("invalid keepAliveMinutes")
        except (ValueError, KeyError) as error:
            raise ActivityError(f"Invalid cloud browser consumer record: {path.name}") from error
        records.append({"agentId": agent, "lastUsedAt": used, "keepAliveMinutes": keep})
    return records


_UNSET = object()


def touch(config, keep_alive_minutes=_UNSET):
    """Atomically touch this consumer; caller must hold its shared/exclusive lock."""
    agent = os.environ.get("KENAN_AGENT") or None
    directory = activity_dir(config)
    path = directory / f"{quote(agent or 'shell', safe='')}.json"
    keep = None
    if path.exists():
        # Do not silently drop another touch's keep-alive setting on bad input.
        try:
            keep = json.loads(path.read_text()).get("keepAliveMinutes")
        except (ValueError, AttributeError) as error:
            raise ActivityError("Invalid cloud browser consumer record.") from error
    if keep_alive_minutes is not _UNSET:
        keep = keep_alive_minutes
    record = {"agentId": agent, "lastUsedAt": time.time_ns() // 1_000_000,
              "keepAliveMinutes": keep}
    temporary = None
    try:
        fd, temporary = tempfile.mkstemp(prefix=".consumer-", dir=directory)
        with os.fdopen(fd, "w") as output:
            json.dump(record, output)
        os.replace(temporary, path)
    finally:
        if temporary is not None:
            Path(temporary).unlink(missing_ok=True)
    return record


@contextmanager
def _lock(config, exclusive):
    directory = activity_dir(config)
    directory.mkdir(mode=0o700, parents=True, exist_ok=True)
    fd = os.open(directory / "lock", os.O_CREAT | os.O_RDWR | os.O_CLOEXEC, 0o600)
    try:
        try:
            fcntl.flock(fd, (fcntl.LOCK_EX if exclusive else fcntl.LOCK_SH) | fcntl.LOCK_NB)
        except BlockingIOError:
            yield None
            return
        yield fd
    finally:
        # Close, rather than explicit LOCK_UN: a command supervisor may have
        # inherited this open file description to outlive a killed wrapper.
        os.close(fd)


@contextmanager
def command_activity(config, keep_alive_minutes=_UNSET):
    """Hold SH throughout use; refuse immediately while stop holds EX."""
    with _lock(config, exclusive=False) as fd:
        if fd is None:
            raise SessionStopping()
        touch(config, keep_alive_minutes)
        try:
            yield fd
        finally:
            touch(config)


@contextmanager
def stop_activity(config):
    """Yield an exclusive lock fd, or None if a command/stop is active."""
    with _lock(config, exclusive=True) as fd:
        yield fd
