import { useContext, useEffect, useState } from 'react';
import type { SocialPostProposal, Todo } from '../shared/contract.js';
import { QuestionContext } from './Question.js';
import { api } from './client.js';
import { apiPath } from './path.js';
import './question.css';

/** Where a question stands, from its to-do. */
export function questionState(t: Todo | undefined): 'open' | 'answered' | 'dismissed' | 'withdrawn' | 'closed' | 'unknown' {
  if (!t) return 'unknown';
  if (t.answer !== null) return 'answered';
  if (t.dismissedAt !== null) return 'dismissed';
  if (t.deletedAt !== null) return 'withdrawn';
  if (t.doneAt !== null) return 'closed';
  return 'open';
}

/** One question's answers as buttons, with Dismiss beside them: tappable while it is open, then the chosen one stays marked. Writing an answer in the chat works too. */
export default function QuestionButtons({ todoId, options, todo }: { todoId: string; options: string[]; todo?: Todo }) {
  const q = useContext(QuestionContext);
  const t = todo ?? q?.todos?.find(x => x.id === todoId);
  const [sending, setSending] = useState<string | null>(null);
  const [preview, setPreview] = useState<{proposal: SocialPostProposal; test: boolean} | null>(null);
  const [previewError, setPreviewError] = useState('');
  useEffect(() => { let live = true; setPreview(null); setPreviewError(''); if (t?.postProposalId) void api<{proposal: SocialPostProposal; test: boolean}>(`/ext/todos/post-proposals/${t.postProposalId}`).then(p => { if (live) setPreview(p); }, e => { if (live) setPreviewError(String(e)); }); return () => { live = false; }; }, [t?.postProposalId]);
  const state = questionState(t);
  const open = state === 'open' && !!q && sending === null && (!t?.postProposalId || preview !== null);
  return <><section className="post-review" hidden={!t?.postProposalId}>
    {previewError && <p role="alert">{previewError}</p>}
    {t?.postProposalId && !preview && !previewError && <p>Loading exact post details…</p>}
    {preview && <><h3>{preview.test ? 'Private test: ' : ''}{preview.proposal.title}</h3>{preview.proposal.posts.map((post, i) => <article key={i}>
      <h4>{post.platform} → {post.destination || 'Not configured — will not post'}</h4><pre>{post.text}</pre>
      {post.link && <p>Link: <a href={post.link} target="_blank" rel="noreferrer">{post.link}</a></p>}
      {(post.images ?? []).map((image, j) => <figure key={j}><img src={apiPath(`/api/ext/todos/post-proposals/${t!.postProposalId}/media/${preview.proposal.media.findIndex(m => m.path === image.path)}`)} alt={image.alt ?? ''}/><figcaption>{image.path.split('/').pop()} · Alt text: {image.alt ?? 'None'}</figcaption></figure>)}
      <details><summary>Exact publication settings</summary><pre>{JSON.stringify(post, null, 2)}</pre></details>
      {post.video && <video controls preload="metadata" src={apiPath(`/api/ext/todos/post-proposals/${t!.postProposalId}/media/${preview.proposal.media.findIndex(m => m.path === (typeof post.video === 'string' ? post.video : post.video?.path))}`)}/>}
    </article>)}</>}
  </section><div className="question-options" role="group" aria-label="Answers">
    {options.map(o => <button key={o} type="button" className={t?.answer === o || sending === o ? 'chosen' : undefined} disabled={!open} aria-pressed={t?.answer === o}
      onClick={() => { if (!q) return; setSending(o); void q.answer(todoId, o).finally(() => setSending(null)); }}>{o}</button>)}
    {state === 'open' && !t?.postProposalId && <button type="button" className="dismiss" disabled={!open} onClick={() => { if (q) { setSending('dismiss'); void q.dismiss(todoId).finally(() => setSending(null)); } }}>Dismiss</button>}
    {state === 'dismissed' && <small>Dismissed</small>}
    {state === 'withdrawn' && <small>Withdrawn</small>}
    {state === 'closed' && <small>Closed</small>}
  </div></>;
}
