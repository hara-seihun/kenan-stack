import { readFile, readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';

/** A profile's context file as prompt text under its path heading; a directory is its files in name order, a missing path is nothing. */
export async function readContext(file: string): Promise<string> {
  const info = await stat(file).catch(() => null);
  if (!info) return '';
  if (info.isDirectory()) return (await Promise.all((await readdir(file)).sort().map(name => readContext(join(file, name))))).join('\n');
  return `\n\n# ${file}\n${await readFile(file, 'utf8')}`;
}

/** The files a context path stands for: itself, a directory's files in name order (recursively), nothing when missing. */
async function contextFiles(path: string): Promise<string[]> {
  const info = await stat(path).catch(() => null);
  if (!info) return [];
  if (!info.isDirectory()) return [path];
  return (await Promise.all((await readdir(path)).sort().map(name => contextFiles(join(path, name))))).flat();
}

/** Pi section names: a letter, then letters, digits, '-' or '_'. */
export const sectionName = (file: string) => `file${file.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`;

/** Each context file as its own system-prompt section, in profile order. When a file changes, Pi re-sends only that section
 * to a running session instead of the whole prompt (on Beta a manager re-sent ~70k tokens per edit or deploy). */
export async function contextSections(paths: readonly string[]): Promise<Record<string, string>> {
  const files = (await Promise.all(paths.map(contextFiles))).flat();
  const sections: Record<string, string> = {};
  for (const file of files) {
    const text = await readFile(file, 'utf8');
    if (text.trim()) sections[sectionName(file)] = `# ${file}\n${text}`;
  }
  return sections;
}
