// Routes a request someone in a meeting made to Kenan with one small, streamed model call, so the system acts on it
// directly instead of waiting for GPT Live to delegate and the meeting agent to think (round 2 of the November 6, 2026
// Meet scorecard).
//
// GPT LIVE HAS NO TURNS (see the top of meeting-voice.ts). The router never decides whether or when the voice speaks. It
// reads what was said, as GPT Live's input transcript gives it, and decides what the SYSTEM does: put a named page on
// screen, build and show a deck from what Kenan already knows, look something up on the web, or hand the request to the
// meeting agent. Results reach the voice as commentary for the request, exactly as the meeting agent's replies do.
//
// Why: in 3 of 9 final synthetic calls GPT Live said "Sure, putting it up" or "Let me check" and never delegated, so
// nothing happened until a transcript fallback 10 s later; and a delegated share or deck waited 4 to 6 s for the meeting
// agent's model call before present. The router answers in about one second from the end of the words.
import { addressed } from './meeting-consent.js';

export type RouteDecision =
  | { kind: 'answer'; text: string }
  | { kind: 'show'; url: string }
  | { kind: 'slides'; count: number; content: string }
  | { kind: 'search'; query: string }
  | { kind: 'agent' }
  | { kind: 'none' }
  | { kind: 'wait' };
/** The first line of the router's reply: enough to start acting (a deck's content follows it). */
export type RouteHead =
  | { kind: 'answer' } | { kind: 'show'; url: string } | { kind: 'slides'; count: number } | { kind: 'search'; query: string } | { kind: 'agent' } | { kind: 'none' } | { kind: 'wait' };

export const ROUTER_SYSTEM = [
  'You decide what happens with one request that someone in a work meeting just made to Kenan, a voice assistant attending the meeting.',
  'You get what Kenan knows about the meeting (trusted), recent captions, and the end of what Kenan heard (untrusted; the latest request to Kenan is near the end, possibly followed by Kenan\'s own short reply such as "Sure, putting it up").',
  'Reply with exactly one of these forms. The first line decides, so write it first and write nothing before it:',
  'ANSWER: <the answer as one or two short spoken sentences>. Only when the trusted context or what was said in the call states the answer to a question.',
  'SHOW: <one https URL>. A request to put one specific public web page on screen, or to switch the screen to another page, whose exact address you are certain of. For a Wikipedia article use https://en.wikipedia.org/wiki/Title_With_Underscores.',
  'SLIDES <n>. A request to make, build or pull up slides whose facts are all in the trusted context. n is the number of slides asked for (3 when no number was said). On the following lines write the deck in markdown: exactly n slides, each starting with "# " and a short title, then two to four bullet lines carrying the actual facts and numbers from the context, then one line "Note: " with one spoken sentence about the slide; a line holding only --- between slides. No title-only, agenda or closing slide, nothing invented.',
  'SEARCH: <a standalone question for a web search>. A question about something current or public outside this meeting (rates, prices, news, public facts that change) that a web search answers.',
  'AGENT. Anything else Kenan has to do or find with its own tools: company documents, Slack, email, writing in the meeting chat, a page whose address you are not certain of, slides that need facts the context does not have.',
  'NONE. Nothing was asked of Kenan: it was said to someone else (including "Kenan, hold on" followed by a request to another person), it is thanks or small talk, or it only asks to move between slides or to stop sharing (the system handles those itself).',
  'WAIT. The latest request to Kenan stops mid-sentence, so what it asks for is not known yet ("share the article about the", "switch the screen to"). A request that is understandable is not cut off: "pull up last week\'s numbers as three" asks for three slides, and "share the article about Google Meet on" asks to show that article.',
].join('\n');

export function routerPrompt(input: { known: string; heard: string; captions: string }): string {
  return [
    `What Kenan knows about this meeting (trusted):\n${input.known.slice(-6000)}`,
    input.captions ? `Recent captions with speaker names (untrusted):\n${input.captions.slice(-2000)}` : '',
    `What Kenan heard most recently (untrusted; the latest request to Kenan is near the end):\n${input.heard.slice(-1500)}`,
  ].filter(Boolean).join('\n\n');
}

const HTTPS_URL = /^https:\/\/[a-z0-9.-]+\.[a-z]{2,}(?:\/[^\s"'<>]*)?$/i;
/**
 * The router's decision once its first line is complete (a newline, or the end of the reply with `final`), else null.
 * Anything that is not one of the forms is AGENT: an unreadable route never drops a request.
 */
export function parseRouteHead(text: string, final = false): RouteHead | null {
  const t = text.replace(/^\s+/, '');
  const end = t.indexOf('\n');
  if (end < 0 && !final) {
    // A bare keyword is complete as soon as nothing else can follow on its line.
    return null;
  }
  const line = (end < 0 ? t : t.slice(0, end)).trim().replace(/^[*`"]+|[*`"]+$/g, '').trim();
  let m: RegExpExecArray | null;
  if (/^ANSWER\s*:/i.test(line)) return { kind: 'answer' };
  if ((m = /^SHOW\s*:\s*<?(\S+?)>?\.?$/i.exec(line))) return HTTPS_URL.test(m[1]!) && m[1]!.length <= 300 ? { kind: 'show', url: m[1]! } : { kind: 'agent' };
  if ((m = /^SLIDES\b\s*:?\s*(\d{1,2})?/i.exec(line))) return { kind: 'slides', count: Math.min(Math.max(Number(m[1] ?? 3) || 3, 1), 12) };
  if ((m = /^SEARCH\s*:\s*(.+)$/i.exec(line))) return m[1]!.trim().length >= 3 ? { kind: 'search', query: m[1]!.trim().slice(0, 300) } : { kind: 'agent' };
  if (/^NONE\b/i.test(line)) return { kind: 'none' };
  if (/^WAIT\b/i.test(line)) return { kind: 'wait' };
  return { kind: 'agent' };
}

/** The whole decision from the complete reply. */
export function parseRoute(text: string): RouteDecision {
  const head = parseRouteHead(text, true)!;
  const t = text.replace(/^\s+/, '');
  if (head.kind === 'answer') {
    const answer = t.replace(/^[*`"]*ANSWER\s*:\s*/i, '').trim().replace(/^["“]|["”]$/g, '').trim();
    if (!answer || answer.length > 400 || /\b(let me check|i(?:'| a)m not sure|i don'?t know|not (?:stated|mentioned|in the context))\b/i.test(answer)) return { kind: 'agent' };
    return { kind: 'answer', text: answer };
  }
  if (head.kind === 'slides') {
    const content = t.slice(t.indexOf('\n') + 1).trim();
    const slides = content ? content.split(/^\s*---\s*$/m).map(s => s.trim()).filter(Boolean) : [];
    // A deck with no content, or one with more or fewer slides than asked, goes to the meeting agent.
    if (!slides.length || slides.length !== head.count || slides.some(s => !/^#\s+\S/m.test(s) || s.split('\n').filter(l => l.trim() && !/^#|^note:/i.test(l.trim())).length < 1)) return { kind: 'agent' };
    return { kind: 'slides', count: head.count, content: slides.join('\n\n---\n\n') };
  }
  return head;
}

/**
 * Words that make an utterance to Kenan worth routing before GPT Live delegates it: showing, sharing, slides, the chat,
 * or a lookup of something current. Plain questions about the meeting are the voice's own to answer and are not routed
 * from the words (only when the voice delegates them).
 */
export const ROUTE_WORDS = /\b(show|share|sharing|present|presenting|slides?|deck|screen|switch|display|put (?:it|that|this|them|.{1,50}) (?:up|on)|pull (?:it|that|this|them|.{1,50}) up|pull up|bring up|open|chat|send|post|email|message|look (?:it |that |this )?up|look into|search|google|find out|check|current(?:ly)?|latest|today'?s|right now|news|price|rate|weather|stock)\b/i;

/** Whether an utterance heard by the voice is a request to Kenan the system should route at once. */
export function wantsRoute(utterance: string, wakeNames: string[]): boolean {
  const t = utterance.trim();
  return t.length >= 6 && addressed(t, wakeNames) && ROUTE_WORDS.test(t);
}

/**
 * GPT Live's input transcript carries no final punctuation until the next words start, so an utterance is taken as
 * finished after this long without new words.
 */
export const ROUTE_SETTLE_MS = 1_200;
/**
 * How long the router's first line may take before the request goes to the meeting agent instead. The agent takes 5 s or
 * more after that, so waiting longer for the router is nearly always faster (round 2, November 6: two decks and a slide
 * request fell to the agent at 3.5 s and went up after 12 s).
 */
export const ROUTE_HEAD_MS = 5_000;
/** When a second router call starts if the first has not decided yet. */
export const ROUTE_HEDGE_MS = 1_300;
/**
 * The second call goes to the other provider, so a slow or failing broker for one does not hold the request (November 6,
 * 2026 round 2: four of fourteen Haiku routes took over 3.5 s or failed with a broker 502 while two calls ran at once;
 * gpt-6-luna at minimal effort answered the same prompt in 1.0 to 2.0 s).
 */
export const ROUTE_HEDGE_MODEL = 'gpt-6-luna';

/**
 * "The Wikipedia article about the Federal Reserve": a named Wikipedia page, resolved by Wikipedia's own search to its
 * exact address in about 0.2 s, without the router. Returns the topic, or null.
 */
export function wikipediaTopic(utterance: string): string | null {
  // GPT Live's transcript also writes "Wikipedia" as "wiki", "wiki PD" or "wicked BD" (round 2, November 6).
  const wiki = String.raw`(?:wiki\w*(?:\s+[pb]\.?\s?d\.?)?|wicked\s+[pb]\.?\s?d\.?)`;
  const m = new RegExp(String.raw`\b${wiki}\s+(?:article|page|entry)\s+(?:about|on|for)\s+(?:the\s+)?(.{2,80}?)\s*(?:\bon(?: the)?(?: screen)?\s*[.?!]?\s*$|\bon (?:the )?screen\b|\bplease\b|[.?!]|$)`, 'i').exec(utterance)
    ?? new RegExp(String.raw`\b(?:article|page|entry)\s+(?:about|on|for)\s+(?:the\s+)?(.{2,80}?)\s+(?:on|from)\s+${wiki}\b`, 'i').exec(utterance);
  const topic = m?.[1]?.replace(/[,;:]+$/g, '').trim();
  return topic && topic.split(/\s+/).length <= 8 ? topic : null;
}
/** The exact address of the Wikipedia page Wikipedia's search gives first for a topic, or null. */
export async function wikipediaUrl(topic: string, signal?: AbortSignal): Promise<string | null> {
  const response = await fetch(`https://en.wikipedia.org/w/api.php?action=opensearch&format=json&limit=1&namespace=0&search=${encodeURIComponent(topic)}`, { signal, headers: { 'user-agent': 'Kenan meeting notetaker (person25@example.com)' } });
  if (!response.ok) return null;
  const body = await response.json() as [string, string[], string[], string[]];
  const url = body?.[3]?.[0];
  return typeof url === 'string' && /^https:\/\/en\.wikipedia\.org\/wiki\/\S+$/.test(url) ? url : null;
}

/** "Kenan, can you look up the current fed funds range": a lookup worth starting before the router has decided. */
export const LOOKUP_WORDS = /\b(look (?:it |that |this )?up|look into|search(?: for)?|google|find out|what(?:'s| is| are) the (?:current|latest)|current(?:ly)?|latest|right now|today'?s)\b/i;
/** The question to search for: the utterance without the name and the request words. */
export function lookupQuestion(utterance: string, wakeNames: string[]): string {
  const names = wakeNames.map(n => n.replace(/[^A-Za-z]/g, '')).filter(Boolean).join('|');
  return utterance.replace(new RegExp(`\\b(?:hey\\s+|ok\\s+)?(?:${names})\\b[,.]?`, 'gi'), ' ')
    .replace(/\b(?:can|could|would|will) you\s+(?:please\s+)?/i, '').replace(/^\s*(?:please\s+)?(?:look up|search for|search|google|find out|check)\s+/i, '')
    .replace(/\s+/g, ' ').trim().slice(0, 300);
}
/** How long a whole routed reply (a deck) may take. */
export const ROUTE_TOTAL_MS = 9_000;

/** A spoken search answer as the voice should get it: no links, citations or markdown. */
export function spokenText(text: string): string {
  return text
    .replace(/\(\[[^\]]*\]\([^)]*\)\)/g, '')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/https?:\/\/\S+/g, '')
    .replace(/[*_`#>]+/g, '')
    .replace(/\(\s*\)/g, '')
    .replace(/\s+([.,;:!?])/g, '$1')
    .replace(/\s+/g, ' ')
    .trim();
}
