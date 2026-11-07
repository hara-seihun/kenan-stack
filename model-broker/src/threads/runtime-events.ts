export type VariantResult<T> = { ok: true; value: T } | { ok: false; error: string };
export function assertNever(value: never): never {
  throw new Error(`Unhandled closed variant: ${String(value).slice(0, 160)}`);
}
