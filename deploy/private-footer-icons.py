#!/usr/bin/env python3
"""Restore a trusted host's private footer art before building a public source snapshot.

capture SOURCE STORE saves the canonical generated asset; apply SOURCE STORE restores it.
The private store stays outside Git and is transferred only to trusted hosts.
"""
import argparse
import pathlib
import re
import shutil
import sys

ASSET = pathlib.Path('web/footerIcons.generated.ts')
NAMES = {'search', 'calendar', 'todo', 'goals', 'usage', 'news', 'sky', 'settings', 'finder'}


def validate(path):
    text = path.read_text()
    keys = {a or b for a, b in re.findall(r'^\s*(?:[\"\']([a-z]+)[\"\']|([a-z]+))\s*:', text, re.M)}
    if (keys != NAMES or not re.search(r'export const footerIcons\s*=', text)
            or not re.search(r'export type FooterIconId\s*=\s*keyof typeof footerIcons', text)):
        raise ValueError(f'{path}: expected footerIcons and FooterIconId with keys {sorted(NAMES)}')


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('action', choices=['capture', 'apply'])
    parser.add_argument('source', type=pathlib.Path)
    parser.add_argument('store', type=pathlib.Path)
    args = parser.parse_args()
    source, store = args.source.resolve(), args.store.resolve()
    if source == store or source in store.parents:
        raise ValueError('the private store must be outside the source tree')
    asset, saved = source / ASSET, store / ASSET.name
    if args.action == 'capture':
        validate(asset)
        store.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(asset, saved)
    else:
        if any((p / '.git').exists() for p in [source, *source.parents]):
            raise ValueError('apply only to a disposable source snapshot without Git metadata')
        validate(asset)
        validate(saved)
        # Replace atomically, retaining the build owner's existing file permissions and owner.
        temporary = asset.with_suffix('.ts.new')
        shutil.copy2(asset, temporary)
        temporary.write_text(saved.read_text())
        shutil.chown(temporary, user=asset.stat().st_uid, group=asset.stat().st_gid)
        temporary.replace(asset)
    print(f'Footer icons: {args.action} complete')


if __name__ == '__main__':
    try:
        main()
    except (OSError, ValueError) as error:
        sys.exit(str(error))
