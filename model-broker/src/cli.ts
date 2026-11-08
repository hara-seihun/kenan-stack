#!/usr/bin/env node
import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";
import { builtinProviders } from "@earendil-works/pi-ai/providers/all";
import { loadBrokerConfig, runModelBroker } from "./model-broker.js";
import { Store } from "./store.js";
import { oauthCredential, transactSharedCredential } from "./auth/shared-oauth.js";

const usage = "Usage: kenan-model-broker model-broker CONFIG | login CONFIG PROVIDER ALIAS | accounts CONFIG";
async function main() {
  const [command, path, family, alias, ...extra] = process.argv.slice(2);
  if (!path || extra.length) throw new Error(usage);
  if (command === "model-broker" && !family && !alias) return runModelBroker(path);
  const config = loadBrokerConfig(path);
  if (command === "accounts" && !family && !alias) {
    const store = Store.open(config.ledgerPath);
    try { console.log(JSON.stringify(store.accounts().map(({ id, provider, enabled }) => ({ id, provider, enabled })), null, 2)); }
    finally { store.close(); }
    return;
  }
  if (command !== "login" || !alias || !family || !["openai-codex", "anthropic", "xai"].includes(family)) throw new Error(usage);
  if (!/^[a-z][a-z0-9_-]*$/.test(alias)) throw new Error("Account alias must contain lowercase letters, numbers, underscores or hyphens");
  if (!config.listeners.some(listener => listener.accounts.includes(alias))) throw new Error("Account alias is not granted to any listener; add it to CONFIG first");
  const provider = builtinProviders().find(candidate => candidate.id === family);
  if (!provider?.auth?.oauth) throw new Error(`No subscription OAuth login for ${family}`);
  const store = Store.open(config.ledgerPath);
  const previous = store.account(alias);
  if (previous && previous.provider !== family) { store.close(); throw new Error("Account alias already belongs to a different provider"); }
  const terminal = createInterface({ input: stdin, output: stdout });
  try {
    const credential = await provider.auth.oauth.login({
      signal: new AbortController().signal,
      async prompt(prompt) {
        if (prompt.type === "select") console.log(prompt.options.map(option => `${option.id}: ${option.label}`).join("\n"));
        return terminal.question(`${prompt.message} `, { signal: prompt.signal });
      },
      notify(event) {
        if (event.type === "auth_url") console.log(event.url, event.instructions ?? "");
        else if (event.type === "device_code") console.log(`Open ${event.verificationUri} and enter ${event.userCode}`);
        else if (event.type === "info") { console.log(event.message); for (const link of event.links ?? []) console.log(link.url); }
        else console.log(event.message);
      },
    });
    if (!oauthCredential(credential)) throw new Error("Provider did not return a subscription OAuth credential");
    await transactSharedCredential(config.authPath, alias, credential, async () => {
      store.upsertAccount({ id: alias, provider: family as "openai-codex" | "anthropic" | "xai", enabled: true, concurrency: 32 });
    });
    console.log(`Subscription account ${alias} is ready. Credentials were saved privately, not printed.`);
  } finally { terminal.close(); store.close(); }
}
main().catch(error => {
  console.error(error instanceof Error ? error.message : String(error));
  // IPC keeps a failed supervisor worker alive unless it exits explicitly.
  process.exit(1);
});
