import importlib.util
from pathlib import Path
import unittest

spec = importlib.util.spec_from_file_location('sharing', Path(__file__).with_name('install-converge-claude-sharing.py'))
sharing = importlib.util.module_from_spec(spec)
spec.loader.exec_module(sharing)


class PatchTests(unittest.TestCase):
    def test_only_affinity_anchor_changes_and_application_is_idempotent(self):
        original = 'unrelated-before\n' + sharing.OLD + '\nunrelated-after'
        desired = 'reviewed-selector'
        selector, broker = sharing.patch_sources(desired, desired, original)
        self.assertEqual(selector, desired)
        self.assertEqual(broker, 'unrelated-before\n' + sharing.NEW + '\nunrelated-after')
        self.assertEqual(sharing.patch_sources(desired, desired, broker), (selector, broker))
        self.assertIn('?? randomUUID());', broker)

    def test_conflicting_source_and_duplicate_anchors_are_not_replaced(self):
        with self.assertRaisesRegex(RuntimeError, 'selector changed'):
            sharing.patch_sources('different-installed-source', 'desired', sharing.OLD)
        with self.assertRaisesRegex(RuntimeError, 'ambiguous'):
            sharing.patch_sources('desired', 'desired', sharing.OLD + sharing.OLD)
        with self.assertRaisesRegex(RuntimeError, 'affinity changed'):
            sharing.patch_sources('desired', 'desired', 'a different broker')


if __name__ == '__main__':
    unittest.main()
