import { lstatSync, readlinkSync } from "node:fs";
import path from "node:path";

// kenan-cold moves a checkout nobody has touched for a while to the Storage Box and leaves a
// symlink into its read-only SMB mount. Such a checkout holds no blocks on this disk, can't be
// written or grow until `kenan-cold restore` turns it back into a directory, and must not be
// walked by periodic jobs: every reader on the host shares the one SMB connection
// (machine/storage.md, 2026-10-31). Only the local symlink is read, never the mount.
const COLD_ROOT = () => process.env.PI_WORKSPACE_COLD_ROOT ?? "/mnt/cold";

// The symlink's identity while it points at the box, or null for anything else.
export function coldIdentity(workspacePath) {
  try {
    const link = lstatSync(workspacePath, { bigint: true });
    if (!link.isSymbolicLink()) return null;
    const target = path.resolve(path.dirname(workspacePath), readlinkSync(workspacePath));
    return target.startsWith(`${COLD_ROOT()}/`) ? `${target}\0${link.ino}\0${link.ctimeNs}` : null;
  } catch { return null; }
}

export function movedToColdStorage(workspacePath) {
  return coldIdentity(workspacePath) !== null;
}

// Whether a path lies inside a folder moved to the box: some ancestor (or the path itself) is a
// symlink into the cold mount. Components are lstat'ed from the root down and the walk stops at
// the first symlink, so nothing on the mount is read.
export function underColdStorage(file) {
  if (!path.isAbsolute(file)) return false;
  let current = "/";
  for (const part of path.normalize(file).split("/").filter(Boolean)) {
    current = path.join(current, part);
    try { if (!lstatSync(current).isSymbolicLink()) continue; } catch { return false; }
    return coldIdentity(current) !== null;
  }
  return false;
}
