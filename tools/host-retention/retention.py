#!/usr/bin/env python3
"""Conservative, work-only host retention. Python standard library, Linux only."""
import argparse
import contextlib
import ctypes
import fcntl
import hashlib
import json
import os
from pathlib import Path
import pwd
import stat
import time
import uuid

ROOTS = (("bun", "/home/kenan/.bun/install/cache"),
         ("npm_tmp", "/home/kenan/.npm/_cacache/tmp"),
         ("logs", "/var/tmp/kenan-bg/kenan"))
STATE = "/var/lib/kenan-host-retention"
ROOT_UID = 0
QUARANTINE = ".kenan-host-retention-quarantine"
MIN_AGE = 24 * 3600
DIR_FLAGS = os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_CLOEXEC | os.O_NOATIME
FILE_FLAGS = os.O_RDONLY | os.O_NOFOLLOW | os.O_CLOEXEC | os.O_NONBLOCK


class Retain(Exception):
    """An explicit reason to preserve data, not permission to guess."""


class CensusRace(Retain):
    """A disappearing proc entry requires a completely fresh census."""


class Budget:
    def __init__(self, seconds=90, max_nodes=2000000):
        self.deadline = time.monotonic() + seconds
        self.max_nodes = max_nodes
        self.nodes = 0

    def check(self):
        if time.monotonic() >= self.deadline:
            raise Retain("runtime_limit")

    def visit(self):
        self.check()
        self.nodes += 1
        if self.nodes > self.max_nodes:
            raise Retain("inspection_limit")


def identity(s):
    return (s.st_dev, s.st_ino)


def fingerprint(s):
    return (s.st_dev, s.st_ino, s.st_mode, s.st_uid, s.st_gid,
            s.st_nlink, s.st_size, s.st_mtime_ns, s.st_ctime_ns, s.st_atime_ns)


def names(fd):
    # scandir's iterator bounds memory even for a very large cache directory.
    return os.scandir(fd)


@contextlib.contextmanager
def directory(path):
    """Walk every absolute component without following symlinks, including parents."""
    path = Path(path)
    if not path.is_absolute() or ".." in path.parts:
        raise Retain("unsafe_absolute_path")
    fd = os.open("/", DIR_FLAGS & ~os.O_NOATIME)
    try:
        for index, part in enumerate(path.parts[1:], 1):
            flags = DIR_FLAGS if index == len(path.parts) - 1 else DIR_FLAGS & ~os.O_NOATIME
            new = os.open(part, flags, dir_fd=fd)
            os.close(fd)
            fd = new
        yield fd
    finally:
        os.close(fd)


@contextlib.contextmanager
def beneath(fd, parts):
    current = os.dup(fd)
    try:
        for part in parts:
            new = os.open(part, DIR_FLAGS, dir_fd=current)
            os.close(current)
            current = new
        yield current
    finally:
        os.close(current)


def snapshot(parent, name, owner, budget, now, age=True):
    """Return a complete bounded tree, or reject the entire top-level entry."""
    result = {}
    root_device = os.fstat(parent).st_dev

    def walk(fd, leaf, rel):
        budget.visit()
        s = os.stat(leaf, dir_fd=fd, follow_symlinks=False)
        if stat.S_ISLNK(s.st_mode):
            raise Retain("symlink")
        if s.st_dev != root_device:
            raise Retain("different_device")
        if s.st_uid != owner:
            raise Retain("not_kenan_owned")
        if not (stat.S_ISDIR(s.st_mode) or stat.S_ISREG(s.st_mode)):
            raise Retain("special_file")
        if stat.S_ISREG(s.st_mode) and s.st_nlink != 1:
            raise Retain("hardlink")
        if age and now - max(s.st_atime, s.st_mtime, s.st_ctime) < MIN_AGE:
            raise Retain("younger_than_24_hours")
        result[rel] = fingerprint(s)
        if stat.S_ISDIR(s.st_mode):
            child = os.open(leaf, DIR_FLAGS, dir_fd=fd)
            try:
                if fingerprint(os.fstat(child)) != result[rel]:
                    raise Retain("tree_changed")
                with names(child) as entries:
                    for entry in entries:
                        walk(child, entry.name, rel + (entry.name,))
                if fingerprint(os.fstat(child)) != result[rel]:
                    raise Retain("tree_changed")
            finally:
                os.close(child)
    walk(parent, name, ())
    return result


def installer(argv):
    verbs = {"install", "ci", "add", "update", "upgrade", "i"}
    for i, arg in enumerate(argv):
        executable = os.path.basename(arg)
        if executable in {"bun", "npm", "npm-cli.js", "npx", "npx-cli.js"}:
            # Options may precede the verb. False positives deliberately retain.
            if any(v in verbs for v in argv[i + 1:]):
                return True
    return False


def process_scan(budget, proc="/proc"):
    # A transient disappearance discards the partial census, never its errors.
    # Only three whole attempts are admitted under the same total budget.
    for attempt in range(3):
        budget.check()
        try:
            return _process_scan_once(budget, proc)
        except CensusRace:
            if attempt == 2:
                raise
    raise AssertionError("Unreachable census state")


def _process_scan_once(budget, proc="/proc"):
    """Inspect every task, not only leaders (tasks can unshare their fd table).

    A vanished process/task/descriptor is tolerated only when it really vanished.
    A failed read of a live process is an explicit global refusal. Kernel threads
    and zombies have no exe, and are recognized by their state/flags, not guessed.
    """
    used = set()

    def stat_target(path):
        try:
            used.add(identity(os.stat(path)))
        except FileNotFoundError:
            # Even a descriptor that closed during inspection prevents effects
            # while its owning task is still alive. Retry only on a later pass.
            raise CensusRace("unreadable_live_process:" + str(path))

    try:
        with os.scandir(proc) as processes:
            for process in processes:
                budget.visit()
                if not process.name.isdigit():
                    continue
                p = Path(proc) / process.name
                try:
                    with os.scandir(p / "task") as tasks:
                        for task in tasks:
                            budget.visit()
                            t = p / "task" / task.name
                            try:
                                # /proc/stat comm may contain spaces and ')'.
                                fields = (t / "stat").read_text().rsplit(")", 1)[1].split()
                                dead_or_kernel = fields[0] in {"Z", "X"} or int(fields[6]) & 0x200000
                                argv = (t / "cmdline").read_bytes().decode("utf-8", "replace").split("\0")
                                if installer(argv):
                                    raise Retain("installer_running")
                                for link in ("cwd", "exe", "root"):
                                    try:
                                        used.add(identity(os.stat(t / link)))
                                    except FileNotFoundError:
                                        if not dead_or_kernel:
                                            raise CensusRace("unreadable_live_process:" + str(t / link))
                                # Threads share an address space, but can unshare
                                # fd and FS tables. Inspect those for every task;
                                # inspect mappings once through the process alias.
                                folders = [(t / "fd")]
                                if task.name == process.name:
                                    folders.append(p / "map_files")
                                for folder in folders:
                                    with os.scandir(folder) as refs:
                                        for ref in refs:
                                            budget.visit()
                                            stat_target(folder / ref.name)
                            except FileNotFoundError as error:
                                if t.exists():
                                    raise CensusRace("unreadable_live_process:" + str(error.filename)) from error
                            except Retain:
                                if t.exists():
                                    raise
                except FileNotFoundError as error:
                    if p.exists():
                        raise CensusRace("unreadable_live_process:" + str(error.filename)) from error
    except OSError as error:
        raise Retain("incomplete_process_scan:" + str(error.errno)) from error
    return used


def unused(tree, used):
    if any((value[0], value[1]) in used for value in tree.values()):
        raise Retain("active_open_or_mapped")


def hash_fd(fd, budget):
    h = hashlib.sha256()
    while True:
        budget.check()
        chunk = os.read(fd, 1024 * 1024)
        if not chunk:
            return h.hexdigest()
        h.update(chunk)


def retirement(parent, name, absolute, tree, custody, budget):
    """Only an exact, explicit root-owned per-file authority can retire a log."""
    if len(tree) != 1 or not stat.S_ISREG(tree[()][2]):
        raise Retain("log_custody_unknown")
    key = hashlib.sha256(absolute.encode()).hexdigest() + ".json"
    try:
        with directory(custody) as cfd:
            cs = os.fstat(cfd)
            if cs.st_uid != ROOT_UID or stat.S_IMODE(cs.st_mode) != 0o700:
                raise Retain("log_custody_unsafe")
            fd = os.open(key, FILE_FLAGS, dir_fd=cfd)
            try:
                s = os.fstat(fd)
                if (not stat.S_ISREG(s.st_mode) or s.st_uid != ROOT_UID or
                        stat.S_IMODE(s.st_mode) != 0o600 or s.st_nlink != 1 or s.st_size > 65536):
                    raise Retain("log_custody_unsafe")
                body = os.read(fd, 65537)
                if fingerprint(os.fstat(fd))[:9] != fingerprint(s)[:9]:
                    raise Retain("log_custody_changed")
                data = json.loads(body)
            finally:
                os.close(fd)
        expected = tree[()]
        if not isinstance(data, dict) or data.get("schema") != 1:
            raise Retain("log_custody_unknown")
        binding = {"path": absolute, "device": expected[0], "inode": expected[1],
                   "size": expected[6], "mtime_ns": expected[7]}
        if any(data.get(k) != v for k, v in binding.items()):
            raise Retain("log_custody_mismatch")
        if (data.get("all_event_and_evidence_references_retired") is not True or
                not isinstance(data.get("authority"), str) or not data["authority"].strip()):
            raise Retain("log_reference_custody_unknown")
        for field in ("retired_event_ids", "retired_evidence_ids"):
            values = data.get(field)
            if not isinstance(values, list) or not values or any(not isinstance(v, str) or not v.strip() for v in values):
                raise Retain("log_reference_custody_unknown")
        # O_NOATIME avoids making a merely inspected log young. Root is required.
        fd = os.open(name, FILE_FLAGS | os.O_NOATIME, dir_fd=parent)
        try:
            if fingerprint(os.fstat(fd)) != expected:
                raise Retain("tree_changed")
            digest = hash_fd(fd, budget)
            if fingerprint(os.fstat(fd)) != expected:
                raise Retain("tree_changed")
        finally:
            os.close(fd)
        if data.get("sha256") != digest:
            raise Retain("log_hash_mismatch")
        return {"custody_file": str(Path(custody) / key), "sha256": digest,
                "authority": data["authority"], "retired_event_ids": data["retired_event_ids"],
                "retired_evidence_ids": data["retired_evidence_ids"]}
    except (OSError, ValueError, TypeError, KeyError) as error:
        raise Retain("log_custody_unknown") from error


def rename_noreplace(source, name, target, new_name):
    # Linux renameat2 is an atomic whole-entry detach, never replacing another
    # writer's entry. No unsafe os.rename fallback exists on unsupported hosts.
    libc = ctypes.CDLL(None, use_errno=True)
    try:
        call = libc.renameat2
    except AttributeError as error:
        raise Retain("atomic_rename_unsupported") from error
    call.argtypes = [ctypes.c_int, ctypes.c_char_p, ctypes.c_int, ctypes.c_char_p, ctypes.c_uint]
    call.restype = ctypes.c_int
    if call(source, os.fsencode(name), target, os.fsencode(new_name), 1) != 0:
        code = ctypes.get_errno()
        raise OSError(code, os.strerror(code))


def atomic_json(fd, name, value):
    temporary = ".report-" + uuid.uuid4().hex
    out = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600, dir_fd=fd)
    try:
        body = (json.dumps(value, sort_keys=True, indent=2) + "\n").encode()
        with os.fdopen(out, "wb") as stream:
            stream.write(body)
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temporary, name, src_dir_fd=fd, dst_dir_fd=fd)
        os.fsync(fd)
    finally:
        try:
            os.unlink(temporary, dir_fd=fd)
        except FileNotFoundError:
            pass


def quarantine(fd):
    try:
        os.mkdir(QUARANTINE, 0o700, dir_fd=fd)
    except FileExistsError:
        pass
    q = os.open(QUARANTINE, DIR_FLAGS, dir_fd=fd)
    s = os.fstat(q)
    if s.st_uid != ROOT_UID or stat.S_IMODE(s.st_mode) != 0o700:
        os.close(q)
        raise Retain("quarantine_unsafe")
    return q


def verify_tree(parent, name, expected, owner, budget, now):
    current = snapshot(parent, name, owner, budget, now, age=False)
    if current != expected:
        raise Retain("tree_changed")


def destroy(parent, name, q, token, tree, owner, budget, scan, record, persist, anchor):
    """A detached entry is inaccessible to Kenan. Never restore a partial tree."""
    expected = dict(tree)
    detached = False
    changed = False
    try:
        verify_tree(parent, name, expected, owner, budget, time.time())
        unused(expected, scan(budget))
        # Recheck after the potentially expensive process census, before rename.
        verify_tree(parent, name, expected, owner, budget, time.time())
        anchor()
        rename_noreplace(parent, name, q, token)
        detached = True
        record["quarantine_entry"] = token
        record["status"] = "detached"
        os.fsync(parent)
        os.fsync(q)
        persist()
        # rename changes only the entry's ctime (and possibly directory metadata).
        new_top = fingerprint(os.stat(token, dir_fd=q, follow_symlinks=False))
        if new_top[:8] != expected[()][:8] or new_top[9] != expected[()][9]:
            raise Retain("tree_changed_after_detach")
        expected[()] = new_top
        verify_tree(q, token, expected, owner, budget, time.time())
        for rel in sorted(expected, key=len, reverse=True):
            budget.check()
            unused(expected, scan(budget))
            verify_tree(q, token, expected, owner, budget, time.time())
            anchor()
            with beneath(q, (token,) + rel[:-1] if rel else ()) as pfd:
                leaf = rel[-1] if rel else token
                s = os.stat(leaf, dir_fd=pfd, follow_symlinks=False)
                if fingerprint(s) != expected[rel]:
                    raise Retain("tree_changed")
                if stat.S_ISDIR(s.st_mode):
                    os.rmdir(leaf, dir_fd=pfd)
                else:
                    os.unlink(leaf, dir_fd=pfd)
                    record["deleted_files"] += 1
                    record["deleted_bytes"] += s.st_size
                changed = True
                record["deleted_nodes"] += 1
                record["deleted_paths"].append(str(Path(record["path"]).joinpath(*rel)))
                del expected[rel]
                if rel:
                    parent_rel = rel[:-1]
                    after = fingerprint(os.fstat(pfd))
                    before = expected[parent_rel]
                    if after[:5] != before[:5]:
                        raise Retain("parent_changed")
                    expected[parent_rel] = after
            persist()
        os.fsync(q)
        record["status"] = "deleted"
        persist()
    except (Retain, OSError) as error:
        record["reason"] = str(error)
        record["status"] = "retained"
        if detached:
            if not changed:
                try:
                    # An uncertain tree must not return to the active cache.
                    unused(expected, scan(budget))
                    verify_tree(q, token, expected, owner, budget, time.time())
                    anchor()
                    rename_noreplace(q, token, parent, name)
                    os.fsync(parent)
                    os.fsync(q)
                    record["status"] = "restored"
                except (Retain, OSError):
                    record["status"] = "quarantined"
            else:
                record["status"] = "quarantined_partial"
        persist()


def run(*, roots=ROOTS, state=STATE, owner=None, apply=False, seconds=90,
        max_files=64, max_bytes=512 * 1024 * 1024, max_nodes=2000000,
        scan=process_scan, clock=time.time):
    if os.geteuid() != 0:
        raise Retain("root_required_for_complete_process_inspection")
    if owner is None:
        owner = pwd.getpwnam("kenan").pw_uid
    budget = Budget(seconds, max_nodes)
    with directory(state) as statefd:
        ss = os.fstat(statefd)
        if ss.st_uid != ROOT_UID or stat.S_IMODE(ss.st_mode) != 0o700:
            raise Retain("state_directory_unsafe")
        lock = os.open("lock", os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW, 0o600, dir_fd=statefd)
        try:
            ls = os.fstat(lock)
            if not stat.S_ISREG(ls.st_mode) or ls.st_uid != ROOT_UID or ls.st_nlink != 1:
                raise Retain("lock_unsafe")
            try:
                fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
            except BlockingIOError as error:
                raise Retain("another_pass_running") from error
            report = {"schema": 1, "apply": apply, "started_at": clock(),
                      "eligible_files": 0, "eligible_bytes": 0, "eligible_nodes": 0,
                      "deleted_files": 0, "deleted_bytes": 0, "deleted_nodes": 0,
                      "retained_reasons": {}, "entries": [],
                      "unsupported_retained": ["/home/kenan/.npm/_cacache/content-v2",
                                                "/home/kenan/.npm/_cacache/index-v5"],
                      "npm_limitation": "Only temporary entries are supported; content and index require npm-owned consistency and are never modified."}

            def persist():
                report["deleted_files"] = sum(r.get("deleted_files", 0) for r in report["entries"])
                report["deleted_bytes"] = sum(r.get("deleted_bytes", 0) for r in report["entries"])
                report["deleted_nodes"] = sum(r.get("deleted_nodes", 0) for r in report["entries"])
                report["retained_reasons"] = {}
                for r in report["entries"]:
                    if "reason" in r:
                        reason = r["reason"]
                        report["retained_reasons"][reason] = report["retained_reasons"].get(reason, 0) + 1
                for r in report["entries"]:
                    if "quarantine_entry" in r:
                        atomic_json(statefd, "quarantine-" + r["quarantine_entry"] + ".json", r)
                atomic_json(statefd, "latest.json", report)

            persist()
            try:
                # A complete preflight is required even in dry-run mode.
                first_used = scan(budget)
                for kind, root in roots:
                    budget.check()
                    try:
                        with directory(root) as parent:
                            with names(parent) as entries:
                                for entry in entries:
                                    budget.visit()
                                    path = str(Path(root) / entry.name)
                                    record = {"path": path, "status": "retained", "deleted_files": 0,
                                              "deleted_bytes": 0, "deleted_nodes": 0, "deleted_paths": []}
                                    report["entries"].append(record)
                                    try:
                                        if entry.name == QUARANTINE:
                                            # An empty control directory is normal after success;
                                            # only surviving entries need reconciliation.
                                            qfd = os.open(entry.name, DIR_FLAGS, dir_fd=parent)
                                            try:
                                                qs = os.fstat(qfd)
                                                if qs.st_uid != ROOT_UID or stat.S_IMODE(qs.st_mode) != 0o700:
                                                    raise Retain("quarantine_unsafe")
                                                with names(qfd) as pending:
                                                    occupied = next(pending, None) is not None
                                            finally:
                                                os.close(qfd)
                                            raise Retain("quarantine_requires_reconciliation" if occupied else "empty_quarantine_control_directory")
                                        tree = snapshot(parent, entry.name, owner, budget, clock())
                                        unused(tree, first_used)
                                        if kind == "logs":
                                            record["retirement"] = retirement(parent, entry.name, path, tree,
                                                                               str(Path(state) / "retirements"), budget)
                                        count = sum(stat.S_ISREG(v[2]) for v in tree.values())
                                        size = sum(v[6] for v in tree.values() if stat.S_ISREG(v[2]))
                                        if (report["eligible_nodes"] + len(tree) > max_files or
                                                report["eligible_bytes"] + size > max_bytes):
                                            raise Retain("deletion_limit")
                                        report["eligible_files"] += count
                                        report["eligible_nodes"] += len(tree)
                                        report["eligible_bytes"] += size
                                        record.update(status="eligible", files=count, bytes=size, nodes=len(tree))
                                        if apply:
                                            # Secure every ancestor again: an fd into a moved parent
                                            # must not turn a deletion into an effect outside the roots.
                                            with directory(root) as fresh:
                                                if identity(os.fstat(fresh)) != identity(os.fstat(parent)):
                                                    raise Retain("root_changed")
                                            q = quarantine(parent)
                                            try:
                                                token = uuid.uuid4().hex
                                                record["quarantine_entry"] = token
                                                record["quarantine_path"] = str(Path(root) / QUARANTINE / token)
                                                record["status"] = "detaching"
                                                record["original_tree"] = [{"relative_parts": list(k), "fingerprint": list(v)} for k, v in tree.items()]
                                                record["root_identity"] = list(identity(os.fstat(parent)))
                                                record["quarantine_identity"] = list(identity(os.fstat(q)))
                                                def anchor():
                                                    budget.check()
                                                    with directory(root) as current_root:
                                                        if identity(os.fstat(current_root)) != identity(os.fstat(parent)):
                                                            raise Retain("root_changed")
                                                        qs = os.stat(QUARANTINE, dir_fd=current_root, follow_symlinks=False)
                                                        if identity(qs) != identity(os.fstat(q)) or not stat.S_ISDIR(qs.st_mode):
                                                            raise Retain("quarantine_changed")
                                                persist()  # Crash before rename is distinguishable from no custody.
                                                # Exact log authority is checked again immediately before detach.
                                                if kind == "logs":
                                                    retirement(parent, entry.name, path, tree,
                                                               str(Path(state) / "retirements"), budget)
                                                destroy(parent, entry.name, q, token, tree, owner,
                                                        budget, scan, record, persist, anchor)
                                            finally:
                                                os.close(q)
                                    except (Retain, OSError) as error:
                                        # A failed report write must not relabel a
                                        # detached/partial effect as untouched.
                                        record["reason"] = str(error)
                                        if record.get("deleted_nodes", 0) and record["status"] != "deleted":
                                            record["status"] = "quarantined_partial"
                                        elif record["status"] == "detached":
                                            record["status"] = "quarantined"
                                        elif record["status"] not in {"deleted", "quarantined_partial", "quarantined", "restored"}:
                                            record["status"] = "retained"
                                    if time.monotonic() >= budget.deadline or budget.nodes > budget.max_nodes:
                                        raise Retain("pass_limit")
                    except FileNotFoundError:
                        report["entries"].append({"path": root, "status": "retained", "reason": "root_absent"})
                    except (Retain, OSError) as error:
                        report["entries"].append({"path": root, "status": "retained", "reason": str(error)})
                        if time.monotonic() >= budget.deadline or budget.nodes > budget.max_nodes:
                            raise Retain("pass_limit")
            except (Retain, OSError) as error:
                report["pass_reason"] = str(error)
            finally:
                report["finished_at"] = clock()
                persist()
            return report
        finally:
            os.close(lock)


def positive(value):
    n = int(value)
    if n <= 0:
        raise argparse.ArgumentTypeError("Must be positive")
    return n


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--apply", action="store_true", help="Delete eligible entries; absent means dry run")
    parser.add_argument("--max-seconds", type=positive, default=90)
    parser.add_argument("--max-files", type=positive, default=64, help="Maximum deletion nodes, including directories")
    parser.add_argument("--max-bytes", type=positive, default=512 * 1024 * 1024)
    parser.add_argument("--max-inspected-nodes", type=positive, default=2000000)
    args = parser.parse_args()
    try:
        result = run(apply=args.apply, seconds=args.max_seconds, max_files=args.max_files,
                     max_bytes=args.max_bytes, max_nodes=args.max_inspected_nodes)
        print(json.dumps({k: v for k, v in result.items() if k != "entries"}, sort_keys=True))
        return 0 if "pass_reason" not in result else 2
    except (Retain, OSError) as error:
        print(json.dumps({"error": str(error), "deleted_files": 0}))
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
