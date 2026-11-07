// The /v1/usage scans run here, on their own thread with their own ledger connections, so a slow disk can stall
// a usage answer but never the broker's event loop (and with it every model call). See BrokerUsageThread.
import { parentPort } from "node:worker_threads";
import { Store } from "./store.js";
import { brokerUsageAcrossStores, type BrokerUsageJob } from "./broker-usage.js";

const stores = new Map<string, Store>();
// Group-by scratch stays in memory: as files it wrote megabytes a minute to a disk already short of IO.
const open = (path: string) => {
  let store = stores.get(path);
  if (!store) { stores.set(path, store = Store.open(path)); store.db.exec("PRAGMA temp_store=MEMORY"); }
  return store;
};
parentPort!.on("message", (job: BrokerUsageJob & { id: number }) => {
  try {
    const body = JSON.stringify(brokerUsageAcrossStores(job.ledgers.map(open), job.principal, job.accounts, job.now, job.allowance));
    parentPort!.postMessage({ id: job.id, body });
  } catch (error) {
    parentPort!.postMessage({ id: job.id, error: error instanceof Error ? error.message : String(error) });
  }
});
