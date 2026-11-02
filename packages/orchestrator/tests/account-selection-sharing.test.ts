import { expect, it } from "vitest";
import { Store } from "../src/store.js";
import { chooseInteractiveAccount } from "../src/auth/account-selection.js";

it("shares sequential Claude sessions despite unequal transferred quota, after restart too", () => {
  const store = Store.open(":memory:"), now = Date.now(), auth = { has: () => true } as never;
  try {
    for (const [id, spent] of [["anthropic-2", 68], ["anthropic-5", 69], ["anthropic-6", 46]] as const) {
      store.upsertAccount({ id, provider: "anthropic" });
      store.recordMeter(id, "anthropic-7d", spent, now + 86400_000);
    }
    store.createLease("previous", "anthropic-6", "interactive", undefined, now - 1000);
    store.endLease("previous", now - 900);
    const selected: string[] = [];
    for (let n = 0; n < 9; n++) {
      // No in-memory cursor: the ledger itself carries fairness across restarts.
      const id = chooseInteractiveAccount(store, auth, "anthropic", undefined, { model: "claude-opus-5-5" })!.id;
      selected.push(id);
      store.createLease(`proof-${n}`, id, "interactive", undefined, now + n);
      store.endLease(`proof-${n}`, now + n + 1);
    }
    expect(selected).toEqual(["anthropic-2", "anthropic-5", "anthropic-6", "anthropic-2", "anthropic-5", "anthropic-6", "anthropic-2", "anthropic-5", "anthropic-6"]);
    store.createLease("busy", "anthropic-2", "interactive");
    expect(chooseInteractiveAccount(store, auth, "anthropic")!.id).toBe("anthropic-5");
    store.recordMeter("anthropic-5", "anthropic-7d", 100, now + 86400_000, now + 1);
    expect(chooseInteractiveAccount(store, auth, "anthropic")!.id).toBe("anthropic-6");
    expect(chooseInteractiveAccount(store, auth, "anthropic", new Set(["anthropic-6"]))!.id).toBe("anthropic-2");
    store.setAccountEnabled("anthropic-2", false);
    expect(chooseInteractiveAccount(store, auth, "anthropic", new Set(["anthropic-6"]))).toBeUndefined();
  } finally { store.close(); }
});
