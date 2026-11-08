/** Source executed by the owner's helper. Never rewrite in place: failed writes leave the old file intact. */
export const REPLACE_FILE_FUNCTION = String.raw`
async function replaceFile(target, data, expected) {
  let temp;
  try {
    let file = target, old = null;
    try { file = await fs.realpath(target); old = await fs.stat(file); }
    catch (error) {
      if (error.code !== 'ENOENT') throw error;
      const link = await fs.lstat(target).catch(e => { if (e.code !== 'ENOENT') throw e; return null; });
      if (link?.isSymbolicLink()) throw Object.assign(new Error('Cannot atomically replace a dangling symlink'), { code: 'ENOENT' });
    }
    if (old && !old.isFile()) throw Object.assign(new Error('Not a regular file'), { code: 'EINVAL' });
    temp = path.join(path.dirname(file), '.' + path.basename(file) + '.' + process.pid + '-' + randomBytes(8).toString('hex') + '.tmp');
    const handle = await fs.open(temp, 'wx', old ? old.mode & 0o7777 : 0o666);
    try {
      await handle.writeFile(data);
      if (old) {
        const created = await handle.stat();
        if (created.uid !== old.uid || created.gid !== old.gid) await handle.chown(old.uid, old.gid);
        await handle.chmod(old.mode & 0o7777);
      }
      await handle.sync();
    } finally { await handle.close(); }
    if (expected !== undefined) {
      const current = await fs.readFile(file);
      if (createHash('sha256').update(current).digest('hex') !== expected)
        throw Object.assign(new Error('File changed during edit'), { code: 'EDIT_CONFLICT' });
    }
    await fs.rename(temp, file);
    temp = undefined;
  } catch (error) {
    error.intact = true;
    throw error;
  } finally { if (temp) await fs.unlink(temp).catch(() => {}); }
}
`;
