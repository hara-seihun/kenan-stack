import { availableParallelism } from "node:os";

export function testSlotCount(env = process.env) {
  if (env.AGENT_WORKSPACE_TEST_SLOTS === undefined) return Math.max(1, Math.floor(availableParallelism() / 4));
  const count = Number(env.AGENT_WORKSPACE_TEST_SLOTS);
  if (!Number.isSafeInteger(count) || count < 1) throw Object.assign(new Error("AGENT_WORKSPACE_TEST_SLOTS must be a positive integer"), { code: "test-slot-config" });
  return count;
}


export const boundedCheckConcurrency = (budget, env = process.env) => Math.min(budget, testSlotCount(env));
