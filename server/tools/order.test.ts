import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir, userInfo } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from '@earendil-works/pi-ai';
import { createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager } from '@earendil-works/pi-coding-agent';
import type { PersonConfig } from '../config.js';
import { ownerTools } from './owner.js';
import { orderedByFiles } from './order.js';

const self = userInfo();

it('a file written by one tool call is there for the next call of the same message, through every owner tool pair', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'kenan-order-'));
  const person = { uid: self.uid, gid: self.gid, home: dir, unixUser: self.username } as PersonConfig;
  const faux = fauxProvider();
  const modelRuntime = await ModelRuntime.create({ authPath: join(dir, 'auth.json'), modelsPath: null, refreshOnCreate: false });
  modelRuntime.registerNativeProvider(faux.provider);
  const settingsManager = SettingsManager.inMemory({ compaction: { enabled: false } });
  const loader = new DefaultResourceLoader({ cwd: dir, agentDir: dir, settingsManager, noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true, systemPrompt: 'test' });
  await loader.reload();
  const customTools = orderedByFiles(ownerTools({ kind: 'callerCgroup' }, person));
  const { session } = await createAgentSession({ cwd: dir, agentDir: dir, modelRuntime, model: faux.getModel(), settingsManager, resourceLoader: loader, sessionManager: SessionManager.inMemory(dir), noTools: 'builtin', customTools, tools: customTools.map(t => t.name) });
  const file = (name: string) => join(dir, name);
  // One message, as models write dependent steps: each call needs what the one before it left on disk. The first Bash is slow, as a real image crop is.
  faux.setResponses([fauxAssistantMessage([
    fauxToolCall('bash', { command: `sleep 0.5; printf from-bash > ${file('crop.txt')}` }),
    fauxToolCall('read', { path: file('crop.txt') }),
    fauxToolCall('write', { path: file('job.sh'), content: 'echo from-write\n' }),
    fauxToolCall('bash', { command: `bash ${file('job.sh')}` }),
    fauxToolCall('bash', { command: `printf 'before\\n' > ${file('note.txt')}` }),
    fauxToolCall('edit', { path: file('note.txt'), edits: [{ oldText: 'before', newText: 'after-edit' }] }),
    fauxToolCall('read', { path: file('note.txt') }),
    fauxToolCall('bash', { command: `cat ${file('note.txt')}` }),
    fauxToolCall('write', { path: file('w.txt'), content: 'from-write-two' }),
    fauxToolCall('read', { path: file('w.txt') }),
  ], { stopReason: 'toolUse' }), fauxAssistantMessage('done')]);
  await session.prompt('go');
  const results = session.messages.filter(m => m.role === 'toolResult').map(m => ({ tool: m.toolName, isError: m.isError, text: m.content.map(c => c.type === 'text' ? c.text : '').join('').trim() }));
  await rm(dir, { recursive: true });
  expect(results.filter(r => r.isError)).toEqual([]);
  expect(results.map(r => r.text)).toEqual([
    '(no output)', 'from-bash', expect.stringMatching(/^Successfully wrote/), 'from-write', '(no output)', expect.stringMatching(/^Successfully replaced/), 'after-edit', 'after-edit', expect.stringMatching(/^Successfully wrote/), 'from-write-two',
  ]);
});
