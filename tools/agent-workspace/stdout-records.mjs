import { closeSync, mkdtempSync, openSync, readSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

// Command output can exceed any in-memory buffer (a `git ls-tree -r` of a large
// repository did). Such commands write stdout to an unlinked temporary file and
// the caller folds it record by record, so memory use is bounded by one chunk
// plus one record regardless of output size.
export function withStdoutFile(launch) {
  const directory = mkdtempSync(path.join(tmpdir(), "aw-stdout-"));
  const file = path.join(directory, "stdout");
  const descriptor = openSync(file, "w+", 0o600);
  rmSync(directory, { recursive: true, force: true });
  try {
    return launch(descriptor);
  } finally {
    closeSync(descriptor);
  }
}

export function foldRecords(descriptor, separator, onRecord) {
  const chunk = Buffer.allocUnsafe(1024 * 1024);
  const sep = Buffer.from(separator);
  let pending = Buffer.alloc(0);
  let position = 0;
  for (;;) {
    const count = readSync(descriptor, chunk, 0, chunk.length, position);
    if (count === 0) break;
    position += count;
    pending = Buffer.concat([pending, chunk.subarray(0, count)]);
    let start = 0;
    for (let at = pending.indexOf(sep, start); at !== -1; at = pending.indexOf(sep, start)) {
      onRecord(pending.toString("utf8", start, at));
      start = at + sep.length;
    }
    pending = pending.subarray(start);
  }
  if (pending.length > 0) onRecord(pending.toString("utf8"));
}
