import './memberColors.css';
import { MEMBER_COLORS } from '../shared/colors.js';
import type { ConversationSummary, Person } from '../shared/contract.js';

/** One person's message colour in this chat: the presets as swatches, and "None" to clear. */
export function MemberColor({ name, value, change }: { name: string; value: string | null; change(color: string | null): void }) {
  return <div className="message-colors" role="radiogroup" aria-label={`Message colour for ${name}`}>
    {MEMBER_COLORS.map(([c, label]) => <button key={c} type="button" role="radio" aria-checked={value === c} aria-label={label} title={label} style={{ background: c }} onClick={() => change(c)}/>)}
    <button type="button" role="radio" className="none" aria-checked={value === null} onClick={() => change(null)}>None</button>
  </div>;
}

/** The Classic ••• menu's section: one row of swatches per person, when two or more people are in the chat. */
export function MemberColorsMenu({ conversation, people, change }: { conversation: ConversationSummary; people: Person[]; change(patch: Record<string, string | null>): void }) {
  const humans = people.filter(p => p.kind === 'human' && conversation.memberIds.includes(p.id));
  return humans.length > 1 ? <><strong>Message colours</strong>{humans.map(p => <div key={p.id} className="mc-row"><span>{p.name}</span><MemberColor name={p.name} value={conversation.memberColors[p.id] ?? null} change={color => change({ [p.id]: color })}/></div>)}</> : null;
}
