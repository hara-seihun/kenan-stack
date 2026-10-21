import { describe, expect, it } from 'vitest';
import { NOTICE_DISPLAY, type Message, type MessageDisplay, type NoticeKind } from '../shared/contract.js';
import { backgroundLabel, transcriptRows, workLabel, type Row } from './transcriptRows.js';

const base = { conversationId: 'c', authorId: 'a', parts: [], state: 'done' as const, clientId: null, createdAt: 1, updatedAt: 1, clipped: false };
const said = (seq: number, role: 'human' | 'assistant' | 'tool', display: MessageDisplay = 'shown', text = `t${seq}`): Message => ({ ...base, id: `m${seq}`, seq, role, notice: null, display, text });
const notice = (seq: number, kind: NoticeKind): Message => ({ ...base, id: `m${seq}`, seq, role: 'notice', notice: kind, display: NOTICE_DISPLAY[kind], text: `t${seq}` });
const ids = (rows: Row[]) => rows.map(row => row.kind === 'message' ? row.message.id : row.messages.map(m => m.id));

describe('transcript rows', () => {
  it('folds runs of background notices into one row and keeps conversation and shown notices as messages', () => {
    const rows = transcriptRows([said(1, 'human'), notice(2, 'worker_note'), notice(3, 'peer_message'), said(4, 'assistant'), notice(5, 'agent_error'), notice(6, 'imported')]);
    expect(ids(rows)).toEqual(['m1', ['m2', 'm3'], 'm4', 'm5', ['m6']]);
  });
  it('folds a manager\'s work on background input with the inputs, never draws NO_REPLY, and keeps a real reply', () => {
    const rows = transcriptRows([
      said(1, 'human'), said(2, 'assistant'),
      notice(3, 'worker_report'), said(4, 'tool', 'background'), said(5, 'assistant', 'silent', 'NO_REPLY'),
      notice(6, 'heartbeat'), said(7, 'tool', 'background'), said(8, 'assistant', 'silent', 'NO_REPLY'),
      notice(9, 'wake'), said(10, 'assistant', 'shown', 'Dave replied'),
    ]);
    expect(ids(rows)).toEqual(['m1', 'm2', ['m3', 'm4', 'm6', 'm7', 'm9'], 'm10']);
    expect(backgroundLabel(rows[2] as Extract<Row, { kind: 'background' }>)).toBe('3 background updates');
  });
});

describe('folded work steps', () => {
  const wbase = { conversationId: 'c', authorId: 'manager:m', state: 'complete', display: 'shown', clipped: false, createdAt: 1, updatedAt: 1 } as const;
  const tool = (id: string, name: string) => ({ ...wbase, id, role: 'tool', text: name, parts: [{ type: 'tool', callId: id, name, args: {}, result: 'ok', isError: false }] }) as unknown as Message;
  const say = (id: string, role: string, text: string) => ({ ...wbase, id, role, text, parts: [] }) as unknown as Message;
  const think = (id: string) => ({ ...wbase, id, role: 'assistant', text: '', parts: [{ type: 'thinking', text: 'hmm' }] }) as unknown as Message;
  const msgs = [say('h', 'human', 'hi'), think('t'), tool('a', 'bash'), tool('b', 'browser'), tool('c', 'bash'), say('r', 'assistant', 'done')];
  it('keeps every step shown by default', () => {
    expect(transcriptRows(msgs).map(r => r.kind)).toEqual(['message', 'message', 'message', 'message', 'message', 'message']);
  });
  it('folds a run of work-only messages into one row between words', () => {
    const rows = transcriptRows(msgs, { foldWork: true });
    expect(rows.map(r => r.kind)).toEqual(['message', 'work', 'message']);
    const work = rows[1] as Extract<typeof rows[number], { kind: 'work' }>;
    expect(work.messages).toHaveLength(4);
    expect(workLabel(work, n => n === 'bash' ? 'Shell' : 'Browser')).toBe('4 steps · Shell, Browser');
  });
  it('never folds words, human messages or files', () => {
    const file = { ...wbase, id: 'f', role: 'assistant', text: '', parts: [{ type: 'file', fileId: 'x', name: 'a.png', mime: 'image/png', size: 1 }] } as unknown as Message;
    expect(transcriptRows([say('h', 'human', 'hi'), file], { foldWork: true }).map(r => r.kind)).toEqual(['message', 'message']);
  });
});
