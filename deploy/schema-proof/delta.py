#!/usr/bin/env python3
"""Helpers for schema-catalog-proof.sh.

allow OLD_SQL NEW_SQL DELTA OUT_DIR
    The expected catalog difference between a fresh OLD and a fresh NEW database is derived from the schema.sql diff:
    a catalog line may differ only when the objects it names are named by a changed line of schema.sql (or the table
    that changed line sits in). Writes OUT_DIR/expected-delta.txt (the exact allowlist: every differing line that the
    diff accounts for), OUT_DIR/unexplained-delta.txt (differing lines the diff does not account for) and
    OUT_DIR/missing-delta.txt (objects the diff adds that the catalog does not show). Exit 0 iff the last two are empty.
fingerprint CATALOG
    SQL printing one line per table: table, row count and an md5 over its rows projected on CATALOG's columns.
exercise OLD_CATALOG NEW_CATALOG
    SQL that writes a non-default value into every column NEW adds to an existing table, so a rollback start and a
    forward start again must also keep data only the new build writes. Exit 3 (typed: column_type_unexercisable) if an
    added column has a type with no rule here.
"""
import difflib
import re
import sys
from pathlib import Path

IDENT = re.compile(r'[A-Za-z_][A-Za-z0-9_]*')
TABLE_START = re.compile(r'^\s*CREATE TABLE (?:IF NOT EXISTS )?(\w+)\s*\(', re.I)
ALTER_TABLE = re.compile(r'\bALTER TABLE (?:IF EXISTS )?(?:ONLY )?(\w+)', re.I)
ADD_COLUMN = re.compile(r'\bALTER TABLE (?:IF EXISTS )?(?:ONLY )?(\w+)\s+ADD COLUMN (?:IF NOT EXISTS )?(\w+)', re.I)
CREATE_INDEX = re.compile(r'\bCREATE (?:UNIQUE )?INDEX (?:CONCURRENTLY )?(?:IF NOT EXISTS )?(\w+)\s+ON (?:ONLY )?(\w+)', re.I)
COLUMN_DEF = re.compile(r'^\s+(\w+)\s+\w')
NOT_COLUMN = {'constraint', 'primary', 'unique', 'check', 'foreign', 'exclude', 'like'}
AUTO_SUFFIX = re.compile(r'^(.+)_(fkey|pkey|key|excl|not_null|idx|check\d*)$')


def code(line):
    return line.split('--', 1)[0].rstrip()


def contexts(lines):
    """Per line: the table whose CREATE TABLE body it sits in, else None."""
    table, out = None, []
    for line in lines:
        start = TABLE_START.match(line)
        if start:
            table = start.group(1)
        out.append(table)
        if table and not start and re.match(r'^\s*\)', line):
            table = None
    return out


def changed(old_lines, new_lines):
    """(sign, code text, enclosing table) for every changed non-comment line."""
    old_ctx, new_ctx = contexts(old_lines), contexts(new_lines)
    out = []
    for tag, i1, i2, j1, j2 in difflib.SequenceMatcher(a=old_lines, b=new_lines, autojunk=False).get_opcodes():
        if tag == 'equal':
            continue
        out += [('-', code(old_lines[i]), old_ctx[i]) for i in range(i1, i2) if code(old_lines[i]).strip()]
        out += [('+', code(new_lines[j]), new_ctx[j]) for j in range(j1, j2) if code(new_lines[j]).strip()]
    return out


def split_words(name, words):
    """True if name is words from the set joined by '_' (auto-generated names over several columns)."""
    if name in words:
        return True
    parts = name.split('_')
    reach = [True] + [False] * len(parts)
    for i in range(len(parts)):
        if reach[i]:
            for j in range(i + 1, len(parts) + 1):
                if '_'.join(parts[i:j]) in words:
                    reach[j] = True
    return reach[-1]


def explained(fields, words):
    kind, rel, name = fields[0], fields[1], fields[2]
    if kind == 'function':
        return rel in words
    if rel not in words:
        return False
    if name in words:
        return True
    if kind in ('constraint', 'index') and name.startswith(rel + '_'):
        rest = name[len(rel) + 1:]
        if re.fullmatch(r'check\d*|pkey', rest):
            return True
        auto = AUTO_SUFFIX.match(rest)
        return split_words(auto.group(1) if auto else rest, words)
    return False


def allow(old_sql, new_sql, delta_path, out_dir):
    old_lines = Path(old_sql).read_text().splitlines()
    new_lines = Path(new_sql).read_text().splitlines()
    diff = changed(old_lines, new_lines)
    words = set()
    for _, text, table in diff:
        words.update(IDENT.findall(text))
        if table:
            words.add(table)
    delta = [l for l in Path(delta_path).read_text().splitlines() if re.match(r'^[-+][^-+]', l)]
    expected = [l for l in delta if explained([f.strip() for f in l[1:].split(' | ')], words)]
    unexplained = [l for l in delta if l not in expected]
    missing = []
    added = {tuple(f.strip() for f in l[1:].split(' | ')[:3]) for l in delta if l.startswith('+')}
    removed = {tuple(f.strip() for f in l[1:].split(' | ')[:3]) for l in delta if l.startswith('-')}
    redefined = {(table, m.group(1)) for sign, text, table in diff if sign == '-' and table
                 for m in [COLUMN_DEF.match(text)] if m and not TABLE_START.match(text)}
    for sign, text, table in diff:
        if sign != '+':
            continue
        for t, c in ADD_COLUMN.findall(text):
            if ('column', t, c) not in added:
                missing.append(f'+column | {t} | {c}  (ALTER TABLE ADD COLUMN in the diff, no new column)')
        for i, t in CREATE_INDEX.findall(text):
            if ('index', t, i) not in added and not any(k == 'index' and n == i for k, _, n in removed):
                missing.append(f'+index | {t} | {i}  (CREATE INDEX in the diff, no new index)')
        col = COLUMN_DEF.match(text)
        if table and col and col.group(1).lower() not in NOT_COLUMN and not TABLE_START.match(text):
            if (table, col.group(1)) not in redefined and ('column', table, col.group(1)) not in added and not any(
                    k == 'column' and r == table and n == col.group(1) for k, r, n in removed):
                missing.append(f'+column | {table} | {col.group(1)}  (column definition added in the diff, no catalog change)')
    out = Path(out_dir)
    (out / 'schema-sql-changed-lines.txt').write_text(''.join(f'{s} [{t or ""}] {x}\n' for s, x, t in diff))
    (out / 'expected-delta.txt').write_text(''.join(l + '\n' for l in expected))
    (out / 'unexplained-delta.txt').write_text(''.join(l + '\n' for l in unexplained))
    (out / 'missing-delta.txt').write_text(''.join(l + '\n' for l in missing))
    return 0 if not unexplained and not missing else 1


def columns(catalog_path):
    tables = {}
    for line in Path(catalog_path).read_text().splitlines():
        f = [x.strip() for x in line.split(' | ')]
        if f[0] == 'column':
            tables.setdefault(f[1], []).append(f[2])
    return tables


def fingerprint(catalog_path):
    parts = []
    for table, cols in sorted(columns(catalog_path).items()):
        sel = ', '.join(f'"{c}"' for c in sorted(cols))
        parts.append(f"SELECT '{table}', count(*), coalesce(md5(string_agg(r::text, E'\\n' ORDER BY r::text)), '-') "
                     f"FROM (SELECT {sel} FROM \"{table}\") r")
    return '\nUNION ALL\n'.join(parts) + '\nORDER BY 1;'


VALUES = {'boolean': 'NOT {c}', 'text': "'schema-proof'", 'bigint': '424242', 'integer': '4242',
          'double precision': '4.25', 'jsonb': '\'{"schema_proof": true}\'', 'date': "DATE '2026-10-22'",
          'smallint': '42', 'real': '4.5', 'numeric': '4.25', 'uuid': "'5c4e3a0e-0000-4000-8000-000000000042'",
          'timestamp with time zone': "TIMESTAMPTZ '2026-10-22 00:00:00Z'"}


def catalog_lines(path):
    return [[x.strip() for x in l.split(' | ')] for l in Path(path).read_text().splitlines()]


def exercise(old_catalog, new_catalog):
    old = {(f[1], f[2]) for f in catalog_lines(old_catalog) if f[0] == 'column'}
    old_tables = {t for t, _ in old}
    new = catalog_lines(new_catalog)
    fks, choices = {}, {}
    for f in new:
        m = re.match(r'FOREIGN KEY \((\w+)\) REFERENCES (\w+)\((\w+)\)', f[4]) if f[0] == 'constraint' else None
        if m:
            fks[(f[1], m.group(1))] = (m.group(2), m.group(3))
        m = re.match(r"CHECK \(\((\w+) = ANY \(ARRAY\[(.*)\]\)\)\)$", f[4]) if f[0] == 'constraint' else None
        if m:
            choices[(f[1], m.group(1))] = re.findall(r"'((?:[^']|'')*)'::text", m.group(2))
    out = []
    for f in new:
        if f[0] != 'column' or f[1] not in old_tables or (f[1], f[2]) in old:
            continue
        table, col, typ = f[1], f[2], f[3]
        if (table, col) in fks:
            rt, rc = fks[(table, col)]
            value = f'(SELECT "{rc}" FROM "{rt}" ORDER BY "{rc}" LIMIT 1)'
        elif len(choices.get((table, col), [])) >= 2:
            first, second = (f"'{v}'" for v in choices[(table, col)][:2])
            value = f'CASE WHEN "{col}" = {first} THEN {second} ELSE {first} END'
        elif typ in VALUES:
            value = VALUES[typ].replace('{c}', f'"{col}"')
        else:
            print(f'column_type_unexercisable: {table}.{col} {typ}', file=sys.stderr)
            return 3
        out.append(f'UPDATE "{table}" SET "{col}" = {value};')
    print('\n'.join(out))
    return 0


if __name__ == '__main__':
    cmd, args = sys.argv[1], sys.argv[2:]
    if cmd == 'allow':
        sys.exit(allow(*args))
    if cmd == 'fingerprint':
        print(fingerprint(*args))
        sys.exit(0)
    if cmd == 'exercise':
        sys.exit(exercise(*args))
    print(f'unknown command {cmd}', file=sys.stderr)
    sys.exit(2)
