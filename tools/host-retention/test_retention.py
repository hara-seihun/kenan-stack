#!/usr/bin/env python3
"""Offline fixtures only: never inspect or remove real caches."""
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import stat
import tempfile
import time
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location("retention", Path(__file__).with_name("retention.py"))
r = importlib.util.module_from_spec(spec)
spec.loader.exec_module(r)


class RetentionTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.base = Path(self.temp.name)
        self.cache = self.base / "cache"
        self.cache.mkdir()
        self.state = self.base / "state"
        self.state.mkdir(mode=0o700)
        self.custody = self.state / "retirements"
        self.custody.mkdir(mode=0o700)
        self.owner = os.getuid()
        self.addCleanup(patch.stopall)
        patch.object(r, "ROOT_UID", self.owner).start()
        patch.object(r.os, "geteuid", return_value=0).start()
        self.future = time.time() + 2 * r.MIN_AGE

    def file(self, name="old", data=b"old data"):
        path = self.cache / name
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(data)
        return path

    def run_pass(self, kind="bun", **kwargs):
        options = dict(roots=((kind, str(self.cache)),), state=str(self.state),
                       owner=self.owner, clock=lambda: self.future, scan=lambda budget: set())
        options.update(kwargs)
        return r.run(**options)

    def authorize(self, path, **changes):
        s = path.stat()
        body = dict(schema=1, path=str(path), device=s.st_dev, inode=s.st_ino,
                    size=s.st_size, mtime_ns=s.st_mtime_ns,
                    sha256=hashlib.sha256(path.read_bytes()).hexdigest(),
                    retired_event_ids=["event:retired-exact"], retired_evidence_ids=["evidence:retired-exact"],
                    all_event_and_evidence_references_retired=True,
                    authority="The owning custody operator explicitly retired every event and evidence reference.")
        body.update(changes)
        destination = self.custody / (hashlib.sha256(str(path).encode()).hexdigest() + ".json")
        destination.write_text(json.dumps(body))
        destination.chmod(0o600)
        return destination

    def test_empty_quarantine_is_not_unresolved_custody(self):
        quarantine = self.cache / r.QUARANTINE
        quarantine.mkdir(mode=0o700)
        report = self.run_pass()
        self.assertIn("empty_quarantine_control_directory", report["retained_reasons"])
        self.assertNotIn("quarantine_requires_reconciliation", report["retained_reasons"])
        (quarantine / "interrupted-entry").write_text("preserve")
        report = self.run_pass()
        self.assertIn("quarantine_requires_reconciliation", report["retained_reasons"])
        self.assertTrue((quarantine / "interrupted-entry").exists())

    def test_default_dry_run(self):
        path = self.file()
        report = self.run_pass()
        self.assertTrue(path.exists())
        self.assertFalse(report["apply"])
        self.assertEqual(report["eligible_files"], 1)
        self.assertEqual(report["deleted_files"], 0)
        self.assertIn("content-v2", report["unsupported_retained"][0])
        self.assertEqual(json.loads((self.state / "latest.json").read_text()), report)

    def test_young_maximum_of_all_timestamps(self):
        path = self.file()
        old = time.time() - 3 * r.MIN_AGE
        os.utime(path, (old, old))
        report = self.run_pass(clock=time.time, apply=True)
        self.assertEqual(report["eligible_files"], 0)  # ctime is recent.
        self.assertTrue(path.exists())
        with r.directory(self.cache) as fd:
            with patch.object(r.os, "stat", wraps=os.stat) as observed:
                original = observed._mock_wraps
                def young_atime(*args, **kwargs):
                    s = original(*args, **kwargs)
                    values = list(s)
                    values[7] = time.time()
                    values[8] = old
                    values[9] = old
                    return os.stat_result(values)
                observed.side_effect = young_atime
                with self.assertRaisesRegex(r.Retain, "younger"):
                    r.snapshot(fd, path.name, self.owner, r.Budget(), time.time())

    def test_whole_package_retained_if_any_child_young(self):
        self.file("package/a")
        self.file("package/b")
        tree = self.cache / "package"
        with patch.object(r, "MIN_AGE", 10 * r.MIN_AGE):
            report = self.run_pass(apply=True)
        self.assertEqual(report["deleted_files"], 0)
        self.assertTrue((tree / "a").exists())

    def test_hardlink_retains_whole_package(self):
        path = self.file("package/a")
        os.link(path, self.cache / "package" / "b")
        report = self.run_pass(apply=True)
        self.assertEqual(report["deleted_files"], 0)
        self.assertIn("hardlink", report["retained_reasons"])
        self.assertEqual(path.stat().st_nlink, 2)

    def test_symlink_never_followed_or_removed(self):
        outside = self.base / "outside"
        outside.write_text("preserve")
        (self.cache / "link").symlink_to(outside)
        self.file("package/a")
        (self.cache / "package" / "link").symlink_to(outside)
        report = self.run_pass(apply=True)
        self.assertEqual(report["deleted_files"], 0)
        self.assertTrue((self.cache / "link").is_symlink())
        self.assertTrue((self.cache / "package" / "a").exists())
        self.assertEqual(outside.read_text(), "preserve")

    def test_special_file_retained(self):
        os.mkfifo(self.cache / "pipe")
        report = self.run_pass(apply=True)
        self.assertIn("special_file", report["retained_reasons"])

    def test_active_inode_and_mapped_inode_retained(self):
        path = self.file()
        report = self.run_pass(apply=True, scan=lambda budget: {r.identity(path.stat())})
        self.assertEqual(report["deleted_files"], 0)
        self.assertIn("active_open_or_mapped", report["retained_reasons"])

    def test_use_appearing_at_immediate_recheck_retains(self):
        path = self.file()
        calls = 0
        def scan(budget):
            nonlocal calls
            calls += 1
            return set() if calls == 1 else {r.identity(path.stat())}
        report = self.run_pass(apply=True, scan=scan)
        self.assertEqual(report["deleted_files"], 0)
        self.assertTrue(path.exists())

    def test_live_process_failure_prevents_every_deletion(self):
        path = self.file()
        def failure(budget):
            raise r.Retain("incomplete_process_scan:13")
        report = self.run_pass(apply=True, scan=failure)
        self.assertEqual(report["pass_reason"], "incomplete_process_scan:13")
        self.assertTrue(path.exists())

    def test_logs_missing_or_malformed_or_unknown_custody_retained(self):
        path = self.file("terminal.log")
        report = self.run_pass(kind="logs", apply=True)
        self.assertIn("log_custody_unknown", report["retained_reasons"])
        authority = self.authorize(path)
        authority.write_text("not json")
        self.assertEqual(self.run_pass(kind="logs", apply=True)["deleted_files"], 0)
        self.authorize(path, all_event_and_evidence_references_retired=False)
        report = self.run_pass(kind="logs", apply=True)
        self.assertIn("log_reference_custody_unknown", report["retained_reasons"])
        self.authorize(path, retired_evidence_ids=[])
        self.assertEqual(self.run_pass(kind="logs", apply=True)["deleted_files"], 0)
        self.assertTrue(path.exists())

    def test_log_wrong_hash_or_identity_retained(self):
        path = self.file("exact.log")
        self.authorize(path, sha256="0" * 64)
        self.assertIn("log_hash_mismatch", self.run_pass(kind="logs", apply=True)["retained_reasons"])
        self.authorize(path, inode=123)
        self.assertIn("log_custody_mismatch", self.run_pass(kind="logs", apply=True)["retained_reasons"])
        self.assertTrue(path.exists())

    def test_explicit_exact_log_retirement(self):
        path = self.file("exact.log")
        self.authorize(path)
        report = self.run_pass(kind="logs", apply=True)
        self.assertEqual(report["deleted_files"], 1, report)
        self.assertFalse(path.exists())
        record = report["entries"][0]
        self.assertEqual(record["status"], "deleted")
        self.assertEqual(record["retirement"]["retired_event_ids"], ["event:retired-exact"])

    def test_unsafe_authority_mode_retains(self):
        path = self.file()
        self.authorize(path).chmod(0o644)
        self.assertIn("log_custody_unsafe", self.run_pass(kind="logs", apply=True)["retained_reasons"])

    def test_bounded_pass_does_not_split_package(self):
        self.file("package/a")
        self.file("package/b")
        report = self.run_pass(apply=True, max_files=2)
        self.assertEqual(report["deleted_files"], 0)
        self.assertTrue((self.cache / "package" / "a").exists())
        report = self.run_pass(apply=True, max_bytes=1)
        self.assertEqual(report["deleted_files"], 0)

    def test_bounded_inspection_and_runtime(self):
        for i in range(10):
            self.file(str(i))
        report = self.run_pass(apply=True, max_nodes=1)
        self.assertEqual(report["deleted_files"], 0)
        self.assertEqual(report["pass_reason"], "pass_limit")
        with patch.object(r.time, "monotonic", side_effect=[0, 2, 2, 2, 2, 2]):
            report = self.run_pass(apply=True, seconds=1)
        self.assertEqual(report["deleted_files"], 0)
        self.assertEqual(report["pass_reason"], "runtime_limit")

    def test_apply_repeat_idempotent_whole_package(self):
        self.file("package/a")
        self.file("package/sub/b")
        report = self.run_pass(apply=True)
        self.assertEqual(report["deleted_files"], 2, report)
        self.assertEqual(report["deleted_nodes"], 4)
        self.assertFalse((self.cache / "package").exists())
        again = self.run_pass(apply=True)
        self.assertEqual(again["deleted_files"], 0)
        journals = list(self.state.glob("quarantine-*.json"))
        self.assertEqual(len(journals), 1)
        self.assertEqual(json.loads(journals[0].read_text())["status"], "deleted")

    def test_interruption_after_detach_preserves_durable_original_identity(self):
        path = self.file("package/a")
        actual = r.rename_noreplace
        def crash(source, name, target, new_name):
            actual(source, name, target, new_name)
            raise KeyboardInterrupt("simulated power loss")
        with patch.object(r, "rename_noreplace", side_effect=crash):
            with self.assertRaises(KeyboardInterrupt):
                self.run_pass(apply=True)
        self.assertFalse(path.exists())
        journals = list(self.state.glob("quarantine-*.json"))
        self.assertEqual(len(journals), 1)
        record = json.loads(journals[0].read_text())
        self.assertEqual(record["status"], "detaching")
        self.assertEqual(record["path"], str(self.cache / "package"))
        self.assertTrue(record["original_tree"])
        self.assertTrue((self.cache / r.QUARANTINE / record["quarantine_entry"] / "a").exists())
        self.assertEqual(self.run_pass(apply=True)["deleted_files"], 0)
        self.assertEqual(json.loads(journals[0].read_text()), record)

    def test_after_one_removal_never_restores_partial_package(self):
        self.file("package/a")
        self.file("package/b")
        calls = 0
        def scan(budget):
            nonlocal calls
            calls += 1
            if calls >= 4:
                raise r.Retain("injected_live_process_failure")
            return set()
        report = self.run_pass(apply=True, scan=scan)
        self.assertFalse((self.cache / "package").exists())
        record = report["entries"][0]
        self.assertEqual(record["status"], "quarantined_partial", report)
        self.assertEqual(report["deleted_files"], 1)
        remaining = self.cache / r.QUARANTINE / record["quarantine_entry"]
        self.assertEqual(len(list(remaining.iterdir())), 1)

    def test_changed_tree_after_detach_and_new_original_refuses_rollback(self):
        self.file("package/a")
        actual = r.rename_noreplace
        def change(source, name, target, new_name):
            actual(source, name, target, new_name)
            if name == "package":
                with r.beneath(target, (new_name,)) as detached:
                    fd = os.open("new", os.O_CREAT | os.O_WRONLY, 0o600, dir_fd=detached)
                    os.close(fd)
                (self.cache / "package").mkdir()
                (self.cache / "package" / "new-writer").write_text("preserve")
        with patch.object(r, "rename_noreplace", side_effect=change):
            report = self.run_pass(apply=True)
        self.assertEqual(report["deleted_files"], 0)
        self.assertEqual(report["entries"][0]["status"], "quarantined")
        self.assertEqual((self.cache / "package" / "new-writer").read_text(), "preserve")

    def test_failed_recheck_before_removal_restores_whole_entry(self):
        path = self.file("package/a")
        calls = 0
        def scan(budget):
            nonlocal calls
            calls += 1
            if calls == 3:
                raise r.Retain("injected_recheck_failure")
            return set()
        report = self.run_pass(apply=True, scan=scan)
        self.assertEqual(report["deleted_files"], 0)
        self.assertEqual(report["entries"][0]["status"], "restored")
        self.assertTrue(path.exists())

    def test_replaced_symlink_parent_is_not_followed(self):
        self.file()
        moved = self.base / "moved-cache"
        outside = self.base / "outside"
        outside.mkdir()
        (outside / "old").write_text("preserve")
        self.cache.rename(moved)
        self.cache.symlink_to(outside)
        report = self.run_pass(apply=True)
        self.assertEqual(report["deleted_files"], 0)
        self.assertEqual((outside / "old").read_text(), "preserve")
        self.assertTrue((moved / "old").exists())

    def test_global_flock_serializes(self):
        import fcntl
        with (self.state / "lock").open("w") as stream:
            fcntl.flock(stream.fileno(), fcntl.LOCK_EX)
            with self.assertRaisesRegex(r.Retain, "another_pass"):
                self.run_pass(apply=True)

    def test_installer_detection(self):
        for argv in (["bun", "add", "pkg"], ["npm", "ci"], ["node", "/usr/lib/npm-cli.js", "--silent", "install"], ["bun", "update"]):
            self.assertTrue(r.installer(argv))
        self.assertFalse(r.installer(["bun", "run", "test"]))

    def fake_proc(self):
        p = self.base / "proc"
        task = p / "123" / "task" / "123"
        task.mkdir(parents=True)
        (task / "stat").write_text("123 (a tricky ) name) S 0 0 0 0 0 0 0")
        (task / "cmdline").write_bytes(b"python3\0worker.py\0")
        for key in ("cwd", "exe", "root"):
            (task / key).symlink_to(self.base)
        (task / "fd").mkdir()
        (p / "123" / "map_files").mkdir()
        return p, task

    def test_complete_process_reader_includes_fds_maps_and_directories(self):
        proc, task = self.fake_proc()
        opened = self.file("open")
        mapped = self.file("mapped")
        (task / "fd" / "3").symlink_to(opened)
        (proc / "123" / "map_files" / "1000-2000").symlink_to(mapped)
        used = r.process_scan(r.Budget(), str(proc))
        self.assertTrue({r.identity(opened.stat()), r.identity(mapped.stat()), r.identity(self.base.stat())} <= used)
        # A separate task can own an independent fd table.
        second = task.parent / "124"
        second.mkdir()
        (second / "stat").write_text("124 (worker) S 0 0 0 0 0 0 0")
        (second / "cmdline").write_bytes(b"npm\0ci\0")
        with self.assertRaisesRegex(r.Retain, "installer_running"):
            r.process_scan(r.Budget(), str(proc))

    def test_live_process_missing_required_read_fails_closed(self):
        proc, task = self.fake_proc()
        (task / "cmdline").unlink()
        with self.assertRaisesRegex(r.Retain, "unreadable_live_process"):
            r.process_scan(r.Budget(), str(proc))

    def test_live_process_permission_error_fails_closed(self):
        proc, task = self.fake_proc()
        original = os.scandir
        def denied(path):
            if str(path).endswith("map_files"):
                raise PermissionError(13, "denied")
            return original(path)
        with patch.object(r.os, "scandir", side_effect=denied):
            with self.assertRaisesRegex(r.Retain, "incomplete_process_scan:13"):
                r.process_scan(r.Budget(), str(proc))

    def test_transient_descriptor_race_restarts_entire_census(self):
        proc, task = self.fake_proc()
        first = self.file("first")
        second = self.file("second")
        link = proc / "123" / "map_files" / "1000-2000"
        link.symlink_to(first)
        actual = os.stat
        raced = False
        def race(path, *args, **kwargs):
            nonlocal raced
            if str(path) == str(link) and not raced:
                raced = True
                link.unlink()
                link.symlink_to(second)
                raise FileNotFoundError(2, "descriptor disappeared", str(link))
            return actual(path, *args, **kwargs)
        with patch.object(r.os, "stat", side_effect=race):
            used = r.process_scan(r.Budget(), str(proc))
        self.assertTrue(raced)
        self.assertIn(r.identity(second.stat()), used)
        self.assertNotIn(r.identity(first.stat()), used)

    def test_permission_errors_are_not_retried(self):
        with patch.object(r, "_process_scan_once", side_effect=r.Retain("incomplete_process_scan:13")) as scan:
            with self.assertRaisesRegex(r.Retain, "incomplete_process_scan:13"):
                r.process_scan(r.Budget())
        self.assertEqual(scan.call_count, 1)

    def test_transient_retries_are_bounded_and_reuse_total_budget(self):
        budget = r.Budget()
        with patch.object(r, "_process_scan_once", side_effect=r.CensusRace("unreadable_live_process")) as scan:
            with self.assertRaises(r.CensusRace):
                r.process_scan(budget)
        self.assertEqual(scan.call_count, 3)
        self.assertTrue(all(call.args[0] is budget for call in scan.call_args_list))

    def test_changed_detached_tree_is_not_restored_even_if_name_free(self):
        self.file("package/a")
        actual = r.rename_noreplace
        def change(source, name, target, new_name):
            actual(source, name, target, new_name)
            if name == "package":
                with r.beneath(target, (new_name,)) as detached:
                    fd = os.open("changed", os.O_CREAT | os.O_WRONLY, 0o600, dir_fd=detached)
                    os.close(fd)
        with patch.object(r, "rename_noreplace", side_effect=change):
            report = self.run_pass(apply=True)
        self.assertEqual(report["deleted_files"], 0)
        self.assertEqual(report["entries"][0]["status"], "quarantined")
        self.assertFalse((self.cache / "package").exists())

    def test_process_scan_has_entry_budget(self):
        proc, task = self.fake_proc()
        with self.assertRaisesRegex(r.Retain, "inspection_limit"):
            r.process_scan(r.Budget(max_nodes=1), str(proc))


if __name__ == "__main__":
    unittest.main()
