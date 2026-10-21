// Startup size budget: the build fails when what a first open must download grows past these limits.
// The phone path is a cellular link at ~300 ms RTT, where every extra 14 KB of slow start is another round trip.
// Raise a limit only with a measured reason (bench/startup/measure.mjs), never to make a build pass.
import { brotliCompressSync, constants } from 'node:zlib';
import type { Plugin, Rollup } from 'vite';
type OutputBundle = Rollup.OutputBundle; type OutputChunk = Rollup.OutputChunk;

/** Brotli bytes, as served (assets are precompressed at quality 11). */
export const BUDGET = { initialJs: 48_000, initialCss: 5_000, html: 1_500 } as const;

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
      const over = (Object.keys(BUDGET) as (keyof typeof BUDGET)[]).filter(key => measured[key] > BUDGET[key]);
      const line = (Object.keys(BUDGET) as (keyof typeof BUDGET)[]).map(key => `${key} ${(measured[key] / 1000).toFixed(1)}/${BUDGET[key] / 1000} kB br`).join(', ');
      if (over.length) this.error(`startup_budget_exceeded: ${over.join(', ')} (${line}). Split, drop or replace what grew; see build/budget.ts.`);
      this.info(`startup budget: ${line}`);
    },
  };
}
