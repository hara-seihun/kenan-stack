import { build } from "esbuild";
import { readdir, copyFile, mkdir } from "node:fs/promises";
import { join } from "node:path";

async function sources(dir) {
  const found = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) found.push(...await sources(path));
    else if (path.endsWith(".ts")) found.push(path);
  }
  return found;
}
await mkdir("dist", { recursive: true });
// Keep the worker and relative module layout: broker-usage opens its worker by URL.
await build({ entryPoints: await sources("src"), outdir: "dist", outbase: "src", platform: "node", target: "node24", format: "esm" });
await copyFile("src/models.json", "dist/models.json");
