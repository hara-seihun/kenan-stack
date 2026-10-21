import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { fauxAssistantMessage, fauxProvider } from '@earendil-works/pi-ai';
import { createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager } from '@earendil-works/pi-coding-agent';
import { TRANSIENT_RETRY } from './runtime.js';

async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), 'kenan-retry-'));
  const faux = fauxProvider();
  const modelRuntime = await ModelRuntime.create({ authPath: join(dir, 'auth.json'), modelsPath: null, refreshOnCreate: false });
  modelRuntime.registerNativeProvider(faux.provider);
  const settingsManager = SettingsManager.inMemory({ retry: { ...TRANSIENT_RETRY, baseDelayMs: 1 }, compaction: { enabled: false } });
  const loader = new DefaultResourceLoader({ cwd: dir, agentDir: dir, settingsManager, noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true, systemPrompt: 'test' });
  await loader.reload();
  const { session } = await createAgentSession({ cwd: dir, agentDir: dir, modelRuntime, model: faux.getModel(), settingsManager, resourceLoader: loader, sessionManager: SessionManager.inMemory(dir), noTools: 'builtin', tools: [] });
  const user = () => session.messages.filter(m => m.role === 'user').length;
  return { faux, session, user };
}
const failure = (errorMessage: string) => fauxAssistantMessage([], { stopReason: 'error', errorMessage });

describe('transient model-call failures', () => {
  it('keep the same turn going past any number of failures without resending its input', async () => {
    const { faux, session, user } = await fixture();
    faux.setResponses([...['Connection error.', '529 overloaded', '503 Service Unavailable', 'socket hang up', 'Connection error.', 'terminated'].map(failure), fauxAssistantMessage('finished the task')]);
    await session.prompt('do the task');
    const last = session.messages.at(-1);
    expect(last).toMatchObject({ role: 'assistant', stopReason: 'stop' });
    expect(user()).toBe(1);
  });
  it('end at an explicit abort during backoff and leave non-transient errors to the agent', async () => {
    const { faux, session } = await fixture();
    faux.setResponses([failure('Connection error.'), fauxAssistantMessage('never sent')]);
    session.settingsManager.applyOverrides({ retry: { ...TRANSIENT_RETRY, baseDelayMs: 60_000 } });
    const turn = session.prompt('do the task');
    while (!session.isRetrying) await new Promise(resolve => setTimeout(resolve, 1));
    await session.abort(); await turn;
    expect(faux.getPendingResponseCount()).toBe(1);
    faux.setResponses([failure('400 invalid_request_error: bad tool schema')]);
    await session.prompt('again');
    expect(session.messages.at(-1)).toMatchObject({ stopReason: 'error' });
  });
});
