import { renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/** Anthropic names the model that actually answered in message_start; the broker compares it with the one asked for. */
export type ServedModel =
  | { kind: "match" }
  | { kind: "mismatch"; requested: string; served: string };

export function servedModelOf(family: string, event: any): string | undefined {
  if (family !== "anthropic" || event?.type !== "message_start") return undefined;
  const served = event.message?.model;
  return typeof served === "string" && served.length > 0 ? served : undefined;
}

export function compareServed(requested: string, served: string): ServedModel {
  return requested === served ? { kind: "match" } : { kind: "mismatch", requested, served };
}

const ALERT_FILE = "model-served-mismatch.md";
/** An alert clears once a day passes with every answer from the requested model. */
export const ALERT_CLEAR_MS = 24 * 3_600_000;
const STALE_CHECK_MS = 3_600_000;

interface Seen { principal: string; accountId: string; requested: string; served: string; count: number; first: number; last: number }

/**
 * Logs every response whose served model differs from the requested one and, when alertDir is set, keeps one host alert
 * file listing them (Kenan Stack's heartbeat reads that inbox). alertDir unset: log lines only.
 */
export class ServedModelWatch {
  private seen = new Map<string, Seen>();
  private staleCheckedAt = 0;

  constructor(private readonly alertDir: string | undefined, private readonly now: () => number = Date.now) {}

  observe(o: { principal: string; accountId: string; requested: string; served: string }): ServedModel {
    const result = compareServed(o.requested, o.served);
    const at = this.now();
    if (result.kind === "match") {
      this.clearIfQuiet(at);
      return result;
    }
    console.error(JSON.stringify({ type: "served_model_mismatch", principal: o.principal, accountId: o.accountId, requested: o.requested, served: o.served }));
    const key = `${o.principal}\u0000${o.accountId}\u0000${o.requested}\u0000${o.served}`;
    const entry = this.seen.get(key);
    if (entry) { entry.count++; entry.last = at; }
    else this.seen.set(key, { ...o, count: 1, first: at, last: at });
    this.write();
    return result;
  }

  private path(): string | undefined {
    return this.alertDir === undefined ? undefined : join(this.alertDir, ALERT_FILE);
  }

  private write(): void {
    const path = this.path();
    if (!path) return;
    const rows = [...this.seen.values()].sort((a, b) => b.last - a.last).map(s =>
      `- ${s.principal} on ${s.accountId}: asked for ${s.requested}, Anthropic answered with ${s.served} (${s.count}×, ${new Date(s.first).toISOString()} to ${new Date(s.last).toISOString()})`);
    const text = [
      "Model broker: Anthropic served a different model than the one requested",
      "",
      ...rows,
      "",
      "Source: message_start.message.model in the provider's stream, compared by kenan-model-broker (src/served-model.ts). Find why the provider substitutes (account entitlement, retired id, alias) and fix the request or the account. This file is removed after 24 h with no mismatch.",
      "",
    ].join("\n");
    const staged = `${path}.${process.pid}.tmp`;
    try {
      writeFileSync(staged, text);
      renameSync(staged, path);
    } catch (error) {
      console.error(JSON.stringify({ type: "served_model_alert_unwritable", path, error: error instanceof Error ? error.message : String(error) }));
    }
  }

  private clearIfQuiet(at: number): void {
    const path = this.path();
    if (!path) return;
    if (this.seen.size) {
      if ([...this.seen.values()].some(s => at - s.last < ALERT_CLEAR_MS)) return;
      this.seen.clear();
      this.remove(path);
      return;
    }
    // A file left by an earlier broker process: clear it once it is a day old.
    if (at - this.staleCheckedAt < STALE_CHECK_MS) return;
    this.staleCheckedAt = at;
    let mtime: number;
    try { mtime = statSync(path).mtimeMs; } catch { return; }
    if (at - mtime >= ALERT_CLEAR_MS) this.remove(path);
  }

  private remove(path: string): void {
    try { unlinkSync(path); } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") console.error(JSON.stringify({ type: "served_model_alert_unremovable", path, error: (error as Error).message }));
    }
  }
}
