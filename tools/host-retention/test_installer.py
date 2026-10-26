"""Offline tests for the dedicated installer; no system services are changed."""
import importlib.machinery
import importlib.util
import json
import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

# The installer exports its own committed source into immutable releases so the
# same tests work from the source tree, candidate export and rollback release.
local = Path(__file__).with_name("installer.py")
source = local if local.exists() else Path(__file__).resolve().parents[2] / "deploy" / "host-retention"
loader = importlib.machinery.SourceFileLoader("host_retention_installer", str(source))
spec = importlib.util.spec_from_loader(loader.name, loader)
i = importlib.util.module_from_spec(spec)
loader.exec_module(i)


class InstallerTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.base = Path(self.temp.name)
        self.addCleanup(patch.stopall)
        patch.object(i, "BASE", self.base / "install").start()
        i.BASE.mkdir()
        patch.object(i, "UNIT_DIRECTORY", self.base / "units").start()
        i.UNIT_DIRECTORY.mkdir()
        self.calls = []
        self.exists = False
        def systemctl(*args):
            self.calls.append(args)
            if args[:2] == ("show", i.UNITS[1]):
                return "loaded" if self.exists else "not-found"
            return ""
        patch.object(i, "systemctl", side_effect=systemctl).start()
        # Other root-controlled production directories are intentionally not
        # created in this nonprivileged, fixture-only test.
        patch.object(i, "safe_dir").start()

    def test_restore_first_install_does_not_disable_missing_unit(self):
        record = dict(schema=1, previous_pointer=None, timer_enabled="not-found", timer_active="unknown",
                      units={name: None for name in i.UNITS})
        for name in i.UNITS:
            (i.UNIT_DIRECTORY / name).write_text("new")
        (i.BASE / "current").symlink_to("releases/" + "a" * 40)
        i.restore(record)
        self.assertFalse((i.BASE / "current").is_symlink())
        self.assertFalse(any((i.UNIT_DIRECTORY / n).exists() for n in i.UNITS))
        self.assertNotIn(("disable", i.UNITS[1]), self.calls)
        self.assertFalse(any(i.UNITS[0] in call and "start" in call for call in self.calls))

    def test_restore_previous_units_pointer_and_timer_only(self):
        self.exists = True
        old = "releases/" + "b" * 40
        record = dict(schema=1, previous_pointer=old, timer_enabled="enabled", timer_active="active",
                      units={name: {"body": "previous " + name, "mode": 0o644} for name in i.UNITS})
        i.restore(record)
        self.assertEqual(os.readlink(i.BASE / "current"), old)
        for name in i.UNITS:
            self.assertEqual((i.UNIT_DIRECTORY / name).read_text(), "previous " + name)
        self.assertIn(("start", i.UNITS[1]), self.calls)
        self.assertNotIn(("start", i.UNITS[0]), self.calls)

    def test_rollback_rejects_external_pointer(self):
        record = dict(schema=1, previous_pointer="/outside", timer_enabled="enabled", timer_active="active",
                      units={name: None for name in i.UNITS})
        with self.assertRaisesRegex(RuntimeError, "Unsafe rollback"):
            i.restore(record)
        self.assertEqual(self.calls, [])

    def test_current_pointer_refuses_unknown_custody(self):
        (i.BASE / "current").symlink_to("/outside")
        with self.assertRaisesRegex(RuntimeError, "outside immutable"):
            i.read_pointer()

    def test_tests_use_isolated_fixture_command_and_unit_validation(self):
        with patch.object(i, "command") as command:
            i.test_source(self.base)
        arguments = [call.args[0] for call in command.call_args_list]
        self.assertEqual(arguments[0][:6], ["/usr/bin/python3", "-I", "-B", "-m", "unittest", "discover"])
        self.assertEqual(arguments[1][:2], ["systemd-analyze", "verify"])
        self.assertFalse(any("--apply" in args for args in arguments))


if __name__ == "__main__":
    unittest.main()
