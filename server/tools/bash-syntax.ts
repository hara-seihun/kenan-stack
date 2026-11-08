/** Shell words, expansions and command boundaries shared by the Bash preflight checks. */
export type Word = { value: string; subs: string[]; assignment: boolean; literal?: boolean; reference?: { name: string; split: boolean }; redirect?: true };
export type Token = { kind: 'word'; word: Word } | { kind: 'op'; op: string } | { kind: 'redir'; heredoc: string | null; expands?: boolean };


/** The text from `open` (just past its opening bracket) to the matching close, honouring quotes; returns the end index. */
function balanced(text: string, at: number, open: string, close: string): number {
  let depth = 1;
  while (at < text.length) {
    const c = text[at]!;
    if (c === '\\') { at += 2; continue; }
    if (c === "'") { const end = text.indexOf("'", at + 1); at = end < 0 ? text.length : end + 1; continue; }
    if (c === '"') { at = doubleQuoted(text, at + 1).end; continue; }
    if (c === open) depth++;
    else if (c === close && --depth === 0) return at;
    at++;
  }
  return text.length;
}

/** A double-quoted string from just past its opening quote: its value, the command substitutions in it, and the index past the close. */
function doubleQuoted(text: string, at: number, stopAtQuote = true): { value: string; subs: string[]; end: number; literal: boolean } {
  let value = ''; const subs: string[] = []; let literal = true;
  while (at < text.length && (!stopAtQuote || text[at] !== '"')) {
    const c = text[at]!;
    if (c === '\\' && at + 1 < text.length) { value += '"$`\\\n'.includes(text[at + 1]!) ? text[at + 1] : c + text[at + 1]; at += 2; continue; }
    if (c === '$' || c === '`') literal = false;
    if (c === '$' && text[at + 1] === '(' && text[at + 2] !== '(') {
      const end = balanced(text, at + 2, '(', ')');
      subs.push(text.slice(at + 2, end)); value += text.slice(at, end + 1); at = end + 1; continue;
    }
    if (c === '`') { const end = text.indexOf('`', at + 1); const stop = end < 0 ? text.length : end; subs.push(text.slice(at + 1, stop)); value += text.slice(at, stop + 1); at = stop + 1; continue; }
    value += c; at++;
  }
  return { value, subs, end: at + 1, literal };
}

/** Unquoted heredocs expand commands locally, including when their stdin goes to SSH. */
export const heredocSubstitutions = (text: string): string[] => doubleQuoted(text, 0, false).subs;

export function tokenize(text: string): Token[] {
  const tokens: Token[] = [];
  const heredocs: Array<{ token: { kind: 'redir'; heredoc: string | null; expands?: boolean }; delimiter: string; strip: boolean }> = [];
  let at = 0;
  const atWordStart = () => tokens.length === 0 || tokens[tokens.length - 1]!.kind !== 'word' || /\s/.test(text[at - 1] ?? ' ');
  while (at < text.length) {
    const c = text[at]!;
    if (c === ' ' || c === '\t') { at++; continue; }
    if (c === '\\' && text[at + 1] === '\n') { at += 2; continue; }
    if (c === '#' && atWordStart()) { while (at < text.length && text[at] !== '\n') at++; continue; }
    if (c === '\n') {
      tokens.push({ kind: 'op', op: ';' }); at++;
      for (const pending of heredocs.splice(0)) {
        const lines: string[] = [];
        while (at < text.length) {
          const end = text.indexOf('\n', at); const stop = end < 0 ? text.length : end;
          const line = text.slice(at, stop); at = stop + 1;
          if ((pending.strip ? line.replace(/^\t+/, '') : line) === pending.delimiter) break;
          lines.push(line);
        }
        pending.token.heredoc = lines.join('\n');
      }
      continue;
    }
    const three = text.slice(at, at + 3); const two = text.slice(at, at + 2);
    if (two === '<<' && three !== '<<<') {
      const strip = text[at + 2] === '-'; at += strip ? 3 : 2;
      while (text[at] === ' ' || text[at] === '\t') at++;
      const start = at; while (at < text.length && !/[\s;&|<>()]/.test(text[at]!)) at++;
      const token = { kind: 'redir' as const, heredoc: null as string | null, expands: !/['"\\]/.test(text.slice(start, at)) };
      tokens.push(token); heredocs.push({ token, delimiter: text.slice(start, at).replace(/['"\\]/g, ''), strip });
      continue;
    }
    if (c === '<' || c === '>' || ((c === '&') && text[at + 1] === '>')) {
      at++; while (at < text.length && '<>&|'.includes(text[at]!)) at++;
      if (text[at] === '-' ) at++;
      tokens.push({ kind: 'redir', heredoc: null }); continue;
    }
    if (two === '|&') { tokens.push({ kind: 'op', op: '|' }); at += 2; continue; }
    if (two === '&&' || two === '||' || two === ';;') { tokens.push({ kind: 'op', op: two }); at += 2; continue; }
    if (c === ';' || c === '&' || c === '|' || c === ')') { tokens.push({ kind: 'op', op: c }); at++; continue; }
    if (c === '(') {
      if (text[at + 1] === '(') { const end = balanced(text, at + 2, '(', ')'); const stop = text[end + 1] === ')' ? end + 2 : end + 1; tokens.push({ kind: 'word', word: { value: text.slice(at, stop), subs: [], assignment: false } }); at = stop; continue; }
      tokens.push({ kind: 'op', op: '(' }); at++; continue;
    }
    // A word: runs of plain characters, quotes, escapes, $(…), ${…} and `…`.
    const start = at;
    let value = ''; const subs: string[] = []; let literal = true;
    while (at < text.length && !/[\s;&|()<>]/.test(text[at]!)) {
      const d = text[at]!;
      if (d === '\\') { value += text[at + 1] ?? ''; at += 2; continue; }
      if (d === "'") { const end = text.indexOf("'", at + 1); const stop = end < 0 ? text.length : end; value += text.slice(at + 1, stop); at = stop + 1; continue; }
      if (d === '"') { const quoted = doubleQuoted(text, at + 1); value += quoted.value; subs.push(...quoted.subs); literal &&= quoted.literal; at = quoted.end; continue; }
      if (d === '$' || d === '`') literal = false;
      if (d === '$' && text[at + 1] === '(') {
        const arithmetic = text[at + 2] === '(';
        const end = balanced(text, at + 2, '(', ')');
        if (!arithmetic) subs.push(text.slice(at + 2, end));
        value += text.slice(at, end + 1); at = end + 1; continue;
      }
      if (d === '$' && text[at + 1] === '{') { const end = balanced(text, at + 2, '{', '}'); value += text.slice(at, end + 1); at = end + 1; continue; }
      if (d === '`') { const end = text.indexOf('`', at + 1); const stop = end < 0 ? text.length : end; subs.push(text.slice(at + 1, stop)); value += text.slice(at, stop + 1); at = stop + 1; continue; }
      value += d; at++;
    }
    // `2>file`: the descriptor number belongs to the redirection, not the command.
    if (/^\d+$/.test(value) && (text[at] === '<' || text[at] === '>')) continue;
    const source = text.slice(start, at);
    const quoted = source.startsWith('"') && source.endsWith('"');
    const reference = /^\$(?:([A-Za-z_][A-Za-z0-9_]*)|\{([A-Za-z_][A-Za-z0-9_]*)\})$/.exec(quoted ? source.slice(1, -1) : source);
    tokens.push({ kind: 'word', word: { value, subs, literal, assignment: /^[A-Za-z_][A-Za-z0-9_]*=/.test(source),
      ...(reference ? { reference: { name: (reference[1] ?? reference[2])!, split: !quoted } } : {}) } });
  }
  return tokens;
}

