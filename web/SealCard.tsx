import type { MessagePart } from '../shared/contract.js';
import './SealCard.css';

type SealPart = Extract<MessagePart, { type: 'seal' }>;

function ServerTime({ at }: { at: number }) {
  const iso = new Date(at).toISOString();
  return <time dateTime={iso}>{iso}</time>;
}

/** Only the server's public commitment is available until it supplies a reveal. */
export function SealCard({ part }: { part: SealPart }) {
  const { reveal } = part;
  return <details className="seal-card" aria-label={`${reveal ? 'Revealed' : 'Sealed'} prediction ${part.id.slice(0, 8)}`}>
    <summary>
      <span className="seal-title">{reveal ? '🔓 revealed' : '🔒 sealed'} {part.id.slice(0, 8)}</span>
      {part.topic && <span className="seal-topic">{part.topic}</span>}
      {reveal && <>
        <span className="seal-guess">{reveal.guess}</span>
        <span className={`seal-check${reveal.verified ? '' : ' seal-mismatch'}`}>
          {reveal.verified ? 'Hash verified' : 'Hash mismatch'} <span className="seal-source">· Server check</span>
        </span>
        {reveal.score && <span className="seal-score">{reveal.score === 'called' ? '✅ called it' : '❌ missed'} <span className="seal-source">· Agent score</span></span>}
      </>}
      {!reveal && <span className="seal-source">Sealed at (server) <ServerTime at={part.sealedAt}/></span>}
      <span className="seal-toggle"><span className="seal-show">Show</span><span className="seal-hide">Hide</span> seal details</span>
    </summary>
    <dl className="seal-facts">
      <dt>Full id</dt><dd><code>{part.id}</code></dd>
      <dt>Sealed at (server)</dt><dd><ServerTime at={part.sealedAt}/></dd>
      <dt>SHA-256</dt><dd><code>{part.hash}</code></dd>
      {reveal && <>
        <dt>Salt</dt><dd><code>{reveal.salt}</code></dd>
        <dt>Revealed at (server)</dt><dd><ServerTime at={reveal.revealedAt}/></dd>
      </>}
      <dt>Commitment format</dt><dd><code>{part.topic != null
        ? "SHA256(JSON.stringify(['seal-guess-v2', salt, topic, guess]))"
        : "SHA256(JSON.stringify(['seal-guess-v1', salt, guess]))"}</code></dd>
    </dl>
  </details>;
}
