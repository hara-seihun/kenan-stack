/** Transport diagnostics must never print request bodies, URLs or credentials. */
export function brokerErrorDiagnostic(error: unknown): unknown {
  if (!(error instanceof Error)) return { name: "unknown" };
  const cause = error.cause as { code?: unknown; syscall?: unknown } | undefined;
  const safe = (value: unknown) => typeof value === "string" && /^[A-Za-z0-9_:-]{1,80}$/.test(value) ? value : undefined;
  return {
    name: safe(error.name),
    code: safe((error as Error & {code?: unknown}).code),
    causeCode: safe(cause?.code),
    syscall: safe(cause?.syscall),
    causes: safeCauses(error.cause),
    // Omit the first line (arbitrary provider messages). Keep only ordinary
    // code locations, never URL-bearing frames or source excerpts.
    stack: error.stack?.split("\n").slice(1).filter(line => /^\s+at [A-Za-z0-9_.$ <>\[\]/():-]+$/.test(line)).slice(0, 12),
  };
}

function safeCauses(value: unknown, depth = 0): unknown {
  if (!value || typeof value !== "object" || depth > 3) return undefined;
  const entry = value as { name?: unknown; code?: unknown; syscall?: unknown; cause?: unknown; errors?: unknown };
  const safe = (v: unknown) => typeof v === "string" && /^[A-Za-z0-9_:-]{1,80}$/.test(v) ? v : undefined;
  return { name: safe(entry.name), code: safe(entry.code), syscall: safe(entry.syscall),
    cause: safeCauses(entry.cause, depth + 1),
    errors: Array.isArray(entry.errors) ? entry.errors.slice(0, 8).map(e => safeCauses(e, depth + 1)) : undefined };
}
