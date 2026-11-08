#!/usr/bin/env python3
"""Select a browser binary without changing sessions, grants or other tools."""
import json
import os
from pathlib import Path
import sys


def select(directory, root):
    root = Path(root)
    paths = set(root.glob('domains/*.json'))
    for channel in ('beta', 'production'):
        channel_path = root / (channel + '.json')
        if not channel_path.exists():
            continue
        config = json.loads(channel_path.read_text())
        for person in config.get('people', []):
            path = person.get('extensionConfigPath')
            if path:
                paths.add(Path(path))
    for path in sorted(paths):
        config = json.loads(path.read_text())
        browser = config.get('tools', {}).get('browser')
        if browser is None:
            continue
        browser['executable'] = str(Path(directory) / 'agent-browser')
        stat = path.stat()
        pending = path.with_name(path.name + '.pending')
        with pending.open('w') as handle:
            json.dump(config, handle, indent=2)
            handle.write('\n')
            handle.flush()
            os.fsync(handle.fileno())
        os.chown(pending, stat.st_uid, stat.st_gid)
        os.chmod(pending, stat.st_mode & 0o7777)
        os.replace(pending, path)
        print('selected', directory, 'for', path)


if __name__ == '__main__':
    select(sys.argv[1], sys.argv[2])
