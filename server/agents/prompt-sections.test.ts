import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { fauxAssistantMessage, fauxProvider } from '@earendil-works/pi-ai';
import { createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager } from '@earendil-works/pi-coding-agent';
import { promptSections, sectionsExtension } from './runtime.js';

async function open(dir: string, sections: Record<string, string>) {
  const faux = fauxProvider();
  const modelRuntime = await ModelRuntime.create({ authPath: join(dir, 'auth.json'), modelsPath: null, refreshOnCreate: false });
  modelRuntime.registerNativeProvider(faux.provider);
  const settingsManager = SettingsManager.inMemory({ compaction: { enabled: false } });
  const loader = new DefaultResourceLoader({ cwd: dir, agentDir: dir, settingsManager, noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true, systemPrompt: 'profile', extensionFactories: [sectionsExtension(sections)] });
  await loader.reload();
  const { session } = await createAgentSession({ cwd: dir, agentDir: dir, modelRuntime, model: faux.getModel(), settingsManager, resourceLoader: loader, sessionManager: SessionManager.open(join(dir, 'session.jsonl'), dir, dir), noTools: 'builtin', tools: [] });
  faux.setResponses([fauxAssistantMessage('ok')]);
  return session;
}
const systemMessages = (messages: readonly { role: string }[]) => messages.filter((m): m is { role: 'system'; sections: Record<string, string | null> } & typeof m => m.role === 'system');

describe('system prompt sections', () => {
  it('a restarted session re-sends only the context file that changed, not the whole prompt', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'kenan-sections-'));
    const first = await open(dir, promptSections({ fileagents: 'AGENTS v1', fileskill: 'SKILL v1' }, '', 'You are worker w1'));
    await first.prompt('hello');
    expect(Object.keys(systemMessages(first.messages)[0]!.sections)).toEqual(['preamble', 'cwd', 'fileagents', 'fileskill', 'role']);
    first.dispose();
    const second = await open(dir, promptSections({ fileagents: 'AGENTS v2', fileskill: 'SKILL v1' }, '', 'You are worker w1'));
    await second.prompt('again');
    const updates = systemMessages(second.messages);
    expect(updates).toHaveLength(2);
    expect(Object.keys(updates[1]!.sections)).toEqual(['fileagents']);
    expect(updates[1]!.sections.fileagents).toContain('AGENTS v2');
  });
});
