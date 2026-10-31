// Sparse selections made only of literal anchored paths ("/compiler/", "/tools/x.py") select exactly
// those paths and everything below them, with no globbing, negation or basename matching. Those are
// computed here instead of by a scratch checkout: on a saturated host the scratch checkout of the
// 508,155-entry seinari tree ran past its 30 s command limit (2026-10-31), so a sparse clone could not
// be priced at all. Anything else returns null and goes to Git's own checkout. sparse-literal.test.mjs
// checks this selection against Git's.

// A literal pattern: leading slash, no glob or escape characters, no empty, "." or ".." component,
// and no trailing whitespace (Git strips unescaped trailing spaces).
const literalPattern = pattern => {
  if (!pattern.startsWith("/") || pattern.length < 2 || /[*?[\]\\]/u.test(pattern) || pattern !== pattern.trimEnd()) return null;
  const directoryOnly = pattern.endsWith("/");
  const body = pattern.slice(1, directoryOnly ? -1 : undefined);
  if (body.split("/").some(part => part === "" || part === "." || part === "..")) return null;
  return { body, directoryOnly };
};

// names: every path in the tree (files, symlinks and gitlinks). Returns the selected names, or null
// when some pattern is not literal.
export function literalSparseSelection(names, patterns) {
  const parsed = patterns.map(literalPattern);
  if (parsed.length === 0 || parsed.some(entry => entry === null)) return null;
  const selected = new Set();
  for (const name of names) {
    if (parsed.some(({ body, directoryOnly }) => name.startsWith(`${body}/`) || (!directoryOnly && name === body))) selected.add(name);
  }
  return selected;
}
