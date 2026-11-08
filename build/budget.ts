// Bound the total first-load transfer by its slow-start flights, not arbitrary per-file limits.
import { brotliCompressSync, constants } from 'node:zlib';
import type { Plugin, Rollup } from 'vite';
type OutputBundle = Rollup.OutputBundle; type OutputChunk = Rollup.OutputChunk;

/** All first-load bytes share one connection. With MSS 1460 and IW10, the first three
 * flights hold 14,600 + 29,200 + 58,400 = 102,200 bytes. Keep 2,200 for headers.
 * Per-file limits used to reject harmless 100-byte changes without changing that latency. */
export const BUDGET = 100_000;

const br = (text: string | Uint8Array) => brotliCompressSync(Buffer.from(text), { params: { [constants.BROTLI_PARAM_QUALITY]: 11 } }).length;

/** The entry chunk and everything it imports statically: what loads before the app can render. */
function initialChunks(bundle: OutputBundle): OutputChunk[] {
  const chunks = new Map(Object.values(bundle).flatMap(o => o.type === 'chunk' ? [[o.fileName, o] as const] : []));
  const seen = new Set<string>();
  const visit = (name: string) => {
    if (seen.has(name)) return;
    seen.add(name);
    for (const next of chunks.get(name)?.imports ?? []) visit(next);
  };
  for (const chunk of chunks.values()) if (chunk.isEntry) visit(chunk.fileName);
  return [...seen].map(name => chunks.get(name)!);
}

export function budget(): Plugin {
  return {
    name: 'startup-size-budget', apply: 'build', enforce: 'post',
    generateBundle(_options, bundle) {
      const initial = initialChunks(bundle);
      const css = new Set(initial.flatMap(chunk => [...(chunk.viteMetadata?.importedCss ?? [])]));
      const measured = {
        initialJs: initial.reduce((sum, chunk) => sum + br(chunk.code), 0),
        initialCss: [...css].reduce((sum, name) => { const asset = bundle[name]; return sum + (asset?.type === 'asset' ? br(asset.source) : 0); }, 0),
        html: Object.values(bundle).reduce((sum, o) => sum + (o.type === 'asset' && o.fileName.endsWith('.html') ? br(o.source) : 0), 0),
      };
      const total = Object.values(measured).reduce((sum, bytes) => sum + bytes, 0);
      const line = process.env.BUDGET_EXACT ? JSON.stringify({ ...measured, total }) : `${total} / ${BUDGET} first-load bytes br (${JSON.stringify(measured)})`;
      if (total > BUDGET) this.error(`startup_budget_exceeded: ${line}. Split, drop or replace what grew; see build/budget.ts.`);
      this.info(`startup budget: ${line}`);
    },
  };
}
