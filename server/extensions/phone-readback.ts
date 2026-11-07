// Literal comparisons supplement Live's semantic readback instructions. This observes text only:
// it neither changes the audio stream nor decides when the voice speaks.
type Kind = 'phone' | 'spelling';
type Comparison = { expected: string; heard: string; kind: Kind; matches: boolean; end: number };
const UNITS: Record<string, number> = { zero: 0, oh: 0, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, zéro: 0, un: 1, une: 1, deux: 2, trois: 3, quatre: 4, cinq: 5, sept: 7, huit: 8, neuf: 9 };
const TEENS: Record<string, number> = { ten: 10, eleven: 11, twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15, sixteen: 16, seventeen: 17, eighteen: 18, nineteen: 19, dix: 10, onze: 11, douze: 12, treize: 13, quatorze: 14, quinze: 15, seize: 16 };
const TENS: Record<string, number> = { twenty: 20, thirty: 30, forty: 40, fifty: 50, sixty: 60, seventy: 70, eighty: 80, ninety: 90, vingt: 20, trente: 30, quarante: 40, cinquante: 50, soixante: 60 };
const hundred = (word: string) => /^(hundred|cents?)$/.test(word);
const numeric = (word: string) => /^\d+$/.test(word) || word in UNITS || word in TEENS || word in TENS || hundred(word);
const normalizePhone = (value: string) => value.length === 11 && value.startsWith('1') ? value.slice(1) : value;
function distance(a: string, b: string): number {
  const row = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    let previous = row[0]!;
    row[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const old = row[j]!;
      row[j] = Math.min(old + 1, row[j - 1]! + 1, previous + (a[i - 1] === b[j - 1] ? 0 : 1));
      previous = old;
    }
  }
  return row[b.length]!;
}
function numberDigits(words: string[]): string {
  let result = '';
  for (let i = 0; i < words.length; i++) {
    const word = words[i]!;
    if (/^\d+$/.test(word)) { result += word; continue; }
    let value = UNITS[word] ?? TEENS[word] ?? TENS[word];
    if (value === undefined) return ''; // An isolated multiplier is ambiguous.
    if (word in TENS && (UNITS[words[i + 1]!] ?? 0) > 0) value += UNITS[words[++i]!]!;
    if (hundred(words[i + 1] ?? '')) {
      value *= 100;
      i++;
      if (words[i + 1]! in TENS) {
        value += TENS[words[++i]!]!;
        if ((UNITS[words[i + 1]!] ?? 0) > 0) value += UNITS[words[++i]!]!;
      } else if (words[i + 1]! in TEENS) value += TEENS[words[++i]!]!;
      else if ((UNITS[words[i + 1]!] ?? 0) > 0) value += UNITS[words[++i]!]!;
    }
    result += value;
  }
  return result;
}
/** Compare only full numbers and delimited spellings with a unique nearby literal in the brief.
 *  A nearest match is a discrepancy candidate, never permission to replace an authoritative value. */
export function literalMaterialReadbacks(authority: string, heard: string): Comparison[] {
  const result: Comparison[] = [];
  const phonePattern = /(?<![\d])(?:\+1\d{10}|(?:\+?1[ .-]?)?(?:\(\d{3}\)|\d{3})[ .-]+\d{3}[ .-]+\d{4})(?!\d)/g;
  const phones = [...new Map([...authority.matchAll(phonePattern)].map(m => [normalizePhone(m[0].replace(/\D/g, '')), m[0]])).entries()];
  const words = [...new Map([...authority.matchAll(/\b[A-Za-z]{5,}\b/g)].map(m => [m[0].toLowerCase(), m[0]])).entries()];
  const tokens = [...heard.matchAll(/[\p{L}]+(?:['’][\p{L}]+)*|\d+/gu)].map(m => ({ word: m[0].toLowerCase(), start: m.index, end: m.index + m[0].length }));
  const record = (values: [string, string][], value: string, start: number, end: number, kind: Kind) => {
    const ranked = values.map(([literal, expected]) => ({ expected, d: distance(literal, value) })).sort((a, b) => a.d - b.d);
    const best = ranked[0];
    if (best && best.d <= 2 && (!ranked[1] || ranked[1].d > best.d)) result.push({ expected: best.expected, heard: heard.slice(start, end), kind, matches: best.d === 0, end });
  };
  for (let i = 0; i < tokens.length;) {
    const first = tokens[i]!;
    if (!numeric(first.word)) { i++; continue; }
    let end = i + 1;
    while (end < tokens.length && numeric(tokens[end]!.word) && /^[\s,.-]*$/.test(heard.slice(tokens[end - 1]!.end, tokens[end]!.start))) end++;
    const value = normalizePhone(numberDigits(tokens.slice(i, end).map(t => t.word)));
    // Ten digits are already a full local number; no silence or sentence boundary is needed.
    if (value.length === 10 && /^[2-9]/.test(value)) record(phones, value, first.start, tokens[end - 1]!.end, 'phone');
    i = end;
  }
  for (let i = 0; i < tokens.length;) {
    const first = tokens[i]!;
    if (!/^[a-z]$/.test(first.word)) { i++; continue; }
    let end = i + 1;
    while (end < tokens.length && /^[a-z]$/.test(tokens[end]!.word) && /^[\s,-]+$/.test(heard.slice(tokens[end - 1]!.end, tokens[end]!.start))) end++;
    const last = tokens[end - 1]!;
    // Unlike full phone numbers, a spelling can still be extended with another letter.
    const complete = /^\s*[.!?;:]/.test(heard.slice(last.end)) || /^\s*[,\s-]+[\p{L}]{2}/u.test(heard.slice(last.end));
    if (end - i >= 5 && complete) record(words, tokens.slice(i, end).map(t => t.word).join(''), first.start, last.end, 'spelling');
    i = end;
  }
  return result.sort((a, b) => a.end - b.end);
}
function exact(value: string, kind: Kind): string {
  return kind === 'phone' ? (value.match(/\d+/g) ?? []).map(group => [...group].join(' ')).join(' / ') : [...value.toUpperCase()].join(' ');
}
/** Facts remain unresolved across overlapping speech, interruptions and a replacement Live session.
 *  Only a complete matching Person readback resolves a discrepancy, not a yes or a partial Kenan correction. */
export class MaterialReadbacks {
  private readonly streams = { Person: { text: '', offset: 0, through: 0 }, Kenan: { text: '', offset: 0, through: 0 } };
  private readonly pending = new Map<string, Comparison>();
  constructor(private readonly authority: string, private readonly fact: (content: string) => void) {}
  observe(who: 'Person' | 'Kenan', delta: string): void {
    const stream = this.streams[who];
    stream.text += delta;
    if (stream.text.length > 4000) { const cut = stream.text.length - 3000; stream.text = stream.text.slice(cut); stream.offset += cut; }
    for (const item of literalMaterialReadbacks(this.authority, stream.text)) {
      const at = stream.offset + item.end;
      if (at <= stream.through) continue;
      stream.through = at;
      const key = `${item.kind}:${item.expected}`;
      if (item.matches) {
        if (who === 'Person' && this.pending.delete(key)) this.fact(`Literal readback comparison: the person's complete ${item.kind} readback now matches ${JSON.stringify(item.expected)}. Only the literal characters match; this says nothing about consent or the surrounding claim.`);
        continue;
      }
      this.pending.set(key, item);
      this.fact(`Literal readback discrepancy in ${who}'s transcript: ${JSON.stringify(item.heard)} does not match the authoritative ${item.kind} ${JSON.stringify(item.expected)}. Exact characters: ${exact(item.expected, item.kind)}. This is not confirmed. A partial correction or an agreeing word does not resolve it.`);
    }
  }
  context(): string {
    return [...this.pending.values()].map(item => `Unresolved ${item.kind} discrepancy: authoritative ${JSON.stringify(item.expected)}, exact characters ${exact(item.expected, item.kind)}; contrary transcript ${JSON.stringify(item.heard)}. No complete matching readback has resolved it.`).join('\n');
  }
}
