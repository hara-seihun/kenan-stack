// Markdown (CommonMark + GFM) rendered straight from marked's tokens to elements: no HTML strings, so raw HTML
// in a message shows as the text it is, and links only open http(s), mailto and tel targets.
import { Fragment, useMemo, type ReactNode } from 'react';
import { Lexer, type MarkedOptions, type Token, type Tokens } from 'marked';

export type MarkdownSource = 'agent' | 'human';
/** People type single newlines as line breaks; agents write Markdown, where a single newline is a space. */
const options: Record<MarkdownSource, MarkedOptions> = { agent: { gfm: true, breaks: false }, human: { gfm: true, breaks: true } };

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: '\u00a0' };
const decode = (text: string) => text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (whole, name: string) => {
  if (name[0] !== '#') return ENTITIES[name.toLowerCase()] ?? whole;
  const code = name[1] === 'x' || name[1] === 'X' ? parseInt(name.slice(2), 16) : parseInt(name.slice(1), 10);
  return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : whole;
});
const SAFE_LINK = /^(?:https?:|mailto:|tel:|#|\/(?!\/)|\.{0,2}\/)/i, SAFE_IMAGE = /^(?:https?:|\/(?!\/)|\.{0,2}\/)/i;
const safe = (url: string, pattern: RegExp): string | undefined => pattern.test(url.trim()) ? url : undefined;

function inline(tokens: Token[] | undefined): ReactNode[] {
  return (tokens ?? []).map((token, key) => {
    const t = token as Tokens.Generic;
    switch (token.type) {
      case 'text': return t.tokens?.length ? <Fragment key={key}>{inline(t.tokens)}</Fragment> : decode(t.text as string);
      case 'escape': return t.text as string;
      case 'strong': return <strong key={key}>{inline(t.tokens)}</strong>;
      case 'em': return <em key={key}>{inline(t.tokens)}</em>;
      case 'del': return <del key={key}>{inline(t.tokens)}</del>;
      case 'codespan': return <code key={key}>{decode(t.text as string)}</code>;
      case 'br': return <br key={key}/>;
      case 'html': return t.text as string;
      case 'link': { const href = safe((token as Tokens.Link).href, SAFE_LINK); return href ? <a key={key} href={href} title={(token as Tokens.Link).title ?? undefined}>{inline(t.tokens)}</a> : <Fragment key={key}>{inline(t.tokens)}</Fragment>; }
      case 'image': { const src = safe((token as Tokens.Image).href, SAFE_IMAGE); return src ? <img key={key} src={src} alt={(token as Tokens.Image).text} title={(token as Tokens.Image).title ?? undefined}/> : (token as Tokens.Image).text; }
      case 'checkbox': return <input key={key} type="checkbox" checked={(token as Tokens.Checkbox).checked} disabled/>;
      default: return t.raw;
    }
  });
}

function table(token: Tokens.Table, key: number): ReactNode {
  const align = (i: number) => token.align[i] ? { textAlign: token.align[i]! } : undefined;
  return <div key={key} className="table-scroll" tabIndex={0}><table style={{ minWidth: `${token.header.length * 5.5}em` }}>
    <thead><tr>{token.header.map((cell, i) => <th key={i} style={align(i)}>{inline(cell.tokens)}</th>)}</tr></thead>
    {token.rows.length > 0 && <tbody>{token.rows.map((row, r) => <tr key={r}>{row.map((cell, i) => <td key={i} style={align(i)}>{inline(cell.tokens)}</td>)}</tr>)}</tbody>}
  </table></div>;
}

function blocks(tokens: Token[], tight = false): ReactNode[] {
  return tokens.map((token, key) => {
    const t = token as Tokens.Generic;
    switch (token.type) {
      case 'space': case 'def': return null;
      case 'paragraph': return tight ? <Fragment key={key}>{inline(t.tokens)}</Fragment> : <p key={key}>{inline(t.tokens)}</p>;
      case 'text': return <Fragment key={key}>{t.tokens ? inline(t.tokens) : decode(t.text as string)}</Fragment>;
      case 'heading': { const Tag = `h${(token as Tokens.Heading).depth}` as 'h1'; return <Tag key={key}>{inline(t.tokens)}</Tag>; }
      case 'code': { const lang = (token as Tokens.Code).lang?.split(/\s/)[0]; return <pre key={key}><code className={lang ? `language-${lang}` : undefined}>{(token as Tokens.Code).text}</code></pre>; }
      case 'blockquote': return <blockquote key={key}>{blocks(t.tokens ?? [])}</blockquote>;
      case 'hr': return <hr key={key}/>;
      case 'checkbox': return <input key={key} type="checkbox" checked={(token as Tokens.Checkbox).checked} disabled/>;
      case 'html': return <p key={key} className="plain-text">{t.text as string}</p>;
      case 'table': return table(token as Tokens.Table, key);
      case 'list': {
        const list = token as Tokens.List;
        const items = list.items.map((item, i) => <li key={i}>{blocks(item.tokens, !list.loose)}</li>);
        return list.ordered ? <ol key={key} start={list.start !== '' && list.start !== 1 ? list.start : undefined}>{items}</ol> : <ul key={key}>{items}</ul>;
      }
      default: return <p key={key}>{t.raw}</p>;
    }
  });
}

export function MessageMarkdown({ text, source }: { text: string; source: MarkdownSource }) {
  const rendered = useMemo(() => blocks(Lexer.lex(text, options[source])), [text, source]);
  return <>{rendered}</>;
}
