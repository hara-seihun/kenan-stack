import { lazy, Suspense, useLayoutEffect, type FormEvent, type RefObject, type Dispatch, type SetStateAction } from 'react';
import type { FileInfo } from '../shared/contract.js';
import { Attachments } from './Attachments.js';
import { useEnterAction } from './enterKey.js';
import { useEmojiSuggest } from './EmojiSuggest.js';
import { pastePlan } from './clipboard.js';
import { apiPath } from './path.js';
import { replyLabel, type ReplyTarget } from './reply.js';
import { useDraft, type Drafts } from './drafts.js';
import type { Dictation } from './MicButton.js';
import type { Upload } from './share.js';
const MicButton = lazy(() => import('./MicButton.js').then(m => ({ default: m.MicButton })));
const contentSized = typeof CSS !== 'undefined' && CSS.supports('field-sizing', 'content');
const Voice = lazy(() => import('./extensions/Voice.js').then(m => ({ default: m.Voice })));

export function Composer({ active, drafts, composerInput, field, dropping, reply, cancelReply, files, removeFile, dictations, setDictations, dismissProblem, uploading, upload, sendDrawing, dictationOn, voiceOn, agentId, micSend, setMicSend, sending, send, submit, onError, working, stop, mentions }: {
  active: string; drafts: Drafts; composerInput: RefObject<HTMLTextAreaElement | null>; field(id: string): HTMLTextAreaElement | null; dropping: boolean;
  reply: ReplyTarget | null; cancelReply(): void; files: FileInfo[]; removeFile(id: string): void;
  dictations: Record<string, Dictation>; setDictations: Dispatch<SetStateAction<Record<string, Dictation>>>; dismissProblem(): void;
  uploading: boolean; upload: Upload; sendDrawing(file: File): Promise<boolean>; dictationOn: boolean; voiceOn: boolean;
  agentId: string | null | undefined; micSend: (() => void) | null; setMicSend: Dispatch<SetStateAction<(() => void) | null>>;
  sending: boolean; send(event: FormEvent): void; submit(id: string, body: string): void;
  onError(text: string): void; working: boolean; stop(): void; mentions: string[];
}) {
  const draft = useDraft(drafts, active), setDrafts = drafts.set;
  const enterAction = useEnterAction();
  const emojiSuggest = useEmojiSuggest(draft, text => setDrafts(all => ({ ...all, [active]: text })), composerInput, mentions);
  const dictating = dictations[active]?.state === 'live';
  const micProblem = dictations[active] ? { id: active, ...dictations[active]! } : null;
  useLayoutEffect(() => {
    const input = composerInput.current; if (!input) return;
    if (contentSized) { if (dictating && document.activeElement !== input) input.scrollTop = input.scrollHeight; return; }
    const resize = () => { input.style.height = 'auto'; input.style.height = `${input.scrollHeight}px`; if (dictating && document.activeElement !== input) input.scrollTop = input.scrollHeight; };
    resize(); const observer = new ResizeObserver(() => { if (input.clientWidth !== width) { width = input.clientWidth; resize(); } });
    let width = input.clientWidth; observer.observe(input); return () => observer.disconnect();
  }, [draft, active, dictating]);
  return <form className={dropping ? 'composer dropping' : 'composer'} onSubmit={send}>
    {emojiSuggest.list}
    {reply && <div className="replying"><span>↩ {replyLabel(reply)}</span><button type="button" aria-label="Cancel reply" onClick={() => cancelReply()}>×</button></div>}
    <div className="attachments">{files.map(file => <span key={file.id}>{file.mime.startsWith('image/') && <img src={apiPath(`/api/files/${file.id}`)} alt=""/>}{file.name}<button type="button" aria-label={`Remove ${file.name}`} onClick={() => removeFile(file.id)}>×</button></span>)}</div>
    <textarea data-update-draft style={contentSized ? { fieldSizing: 'content' } : undefined} ref={composerInput} aria-label="Message" aria-describedby="composer-help" placeholder="Message…" value={draft} onChange={e => { setDrafts(all => ({ ...all, [active]: e.target.value })); emojiSuggest.track(e); }} onSelect={emojiSuggest.track} onPaste={e => { const plan = pastePlan(e.clipboardData, new Date()); if (plan.kind === 'files') { e.preventDefault(); void upload(plan.files); } }} enterKeyHint={enterAction === 'send' ? 'send' : 'enter'} onKeyDown={e => { if (emojiSuggest.onKey(e)) return; if (enterAction === 'send' && e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); e.currentTarget.form?.requestSubmit(); } }} rows={1}/>
    {micProblem?.state === 'failed' && <p className="mic-problem" role="alert"><span>🎤 {micProblem.message}</span>{micProblem.retry && <button type="button" onClick={micProblem.retry}>Try again</button>}<button type="button" aria-label="Dismiss" onClick={() => { micProblem.box.stop(); dismissProblem(); }}>✕</button></p>}
    <div className="composer-controls">
      <Attachments uploading={uploading} upload={upload} sendDrawing={sendDrawing}/>
      {dictationOn && <Suspense fallback={null}><MicButton conversationId={active} disabled={uploading} composer={{ dictations, setDictations, draft: id => drafts.get()[id] ?? '', save: (id, text) => setDrafts(all => ({ ...all, [id]: text })), field, submit: (id, body) => void submit(id, body), onLive: finish => setMicSend(() => finish), onError }}/></Suspense>}
      {voiceOn && agentId && <Suspense fallback={null}><Voice conversationId={active} onError={onError}/></Suspense>}
      <span/>
      {working && <button type="button" onClick={() => stop()}>Stop</button>}
      <button className={micSend ? 'send live' : 'send'} type="submit" disabled={!micSend && (sending || uploading || dictations[active]?.state === 'live' || (!draft.trim() && !files.length))}>{sending ? 'Sending…' : 'Send ↑'}</button>
    </div>
    <small id="composer-help" className="composer-help">Enter to send · Shift + Enter for a new line</small>
  </form>;
}
