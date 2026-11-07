// Markdown (CommonMark + GFM) rendered straight from marked's tokens to elements: no HTML strings, so raw HTML
// in a message shows as the text it is, and links only open http(s), mailto and tel targets, or a chat she can open (chat:<id>).
import { Fragment, useContext, useMemo, type ReactNode } from 'react';
import { Lexer, Tokenizer, type MarkedOptions, type Token, type Tokens } from 'marked';
import { emojiSrc, onlyEmoji, withEmoji } from './emoji.js';
import { ChatLinkContext, parseChatLink, chatLinkHref, type ChatLinks } from './chatLinks.js';

export type MarkdownSource = 'agent' | 'human';
const ORDERED_ITEM = /\n {0,3}\d{1,9}[.)][ \t]+\S/;
/** CommonMark lets only "1." interrupt a paragraph; people and agents continue numbering under a heading line ("**Part 2**\n4. …"), so any number starts a list. */
const tokenizer = new class extends Tokenizer {
  override paragraph(src: string) { return super.paragraph(src.slice(0, src.search(ORDERED_ITEM) + 1 || undefined)); }
  /** GFM also strikes through a single pair of tildes; people and agents write "~25%" and "~$2" to mean "about", so only ~~double~~ strikes. */
  override del(src: string, masked: string, prev: string) { return src.startsWith('~~') ? super.del(src, masked, prev) : undefined; }
}();
/** People type single newlines as line breaks; agents write Markdown, where a single newline is a space. */
const options: Record<MarkdownSource, MarkedOptions> = {
  agent: { gfm: true, breaks: false, tokenizer },
  human: { gfm: true, breaks: true, tokenizer },
};

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: '\u00a0' };
const decode = (text: string) => text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (whole, name: string) => {
  if (name[0] !== '#') return ENTITIES[name.toLowerCase()] ?? whole;
  const code = name[1] === 'x' || name[1] === 'X' ? parseInt(name.slice(2), 16) : parseInt(name.slice(1), 10);
  return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : whole;
});
const SAFE_LINK = /^(?:https?:|mailto:|tel:|#|\/(?!\/)|\.{0,2}\/)/i, SAFE_IMAGE = /^(?:https?:|\/(?!\/)|\.{0,2}\/)/i;
const safe = (url: string, pattern: RegExp): string | undefined => pattern.test(url.trim()) ? url : undefined;

/** Plain text with its custom-emoji shortcodes shown as inline images. */
const text = (plain: string): ReactNode => withEmoji(plain).map((part, key) => typeof part === 'string' ? part : <img key={key} className="emoji" src={emojiSrc(part.name)} alt={part.code}/>);

function inline(tokens: Token[] | undefined, links: ChatLinks | null): ReactNode[] {
  return (tokens ?? []).map((token, key) => {
    const t = token as Tokens.Generic;
    switch (token.type) {
      case 'text': return t.tokens?.length ? <Fragment key={key}>{inline(t.tokens, links)}</Fragment> : text(decode(t.text as string));
      case 'escape': return t.text as string;
      case 'strong': return <strong key={key}>{inline(t.tokens, links)}</strong>;
      case 'em': return <em key={key}>{inline(t.tokens, links)}</em>;
      case 'del': return <del key={key}>{inline(t.tokens, links)}</del>;
      case 'codespan': return <code key={key}>{decode(t.text as string)}</code>;
      case 'br': return <br key={key}/>;
      case 'html': return t.text as string;
      case 'link': {
        const chat = parseChatLink((token as Tokens.Link).href);
        if (chat !== null) return links?.canOpen(chat.conversationId)
          ? <a key={key} className="chat-link" href={chatLinkHref(chat)} onClick={event => { event.preventDefault(); links.open(chat.conversationId, chat.message); }}>{inline(t.tokens, links)}</a>
          : <Fragment key={key}>{inline(t.tokens, links)}</Fragment>;
        const href = safe((token as Tokens.Link).href, SAFE_LINK); return href ? <a key={key} href={href} title={(token as Tokens.Link).title ?? undefined}>{inline(t.tokens, links)}</a> : <Fragment key={key}>{inline(t.tokens, links)}</Fragment>; }
      case 'image': { const src = safe((token as Tokens.Image).href, SAFE_IMAGE); return src ? <img key={key} src={src} alt={(token as Tokens.Image).text} title={(token as Tokens.Image).title ?? undefined}/> : (token as Tokens.Image).text; }
      case 'checkbox': return <input key={key} type="checkbox" checked={(token as Tokens.Checkbox).checked} disabled/>;
      default: return t.raw;
    }
  });
}

function table(token: Tokens.Table, key: number, links: ChatLinks | null): ReactNode {
  const align = (i: number) => token.align[i] ? { textAlign: token.align[i]! } : undefined;
  return <div key={key} className="table-scroll" tabIndex={0}><table style={{ minWidth: `${token.header.length * 5.5}em` }}>
    <thead><tr>{token.header.map((cell, i) => <th key={i} style={align(i)}>{inline(cell.tokens, links)}</th>)}</tr></thead>
    {token.rows.length > 0 && <tbody>{token.rows.map((row, r) => <tr key={r}>{row.map((cell, i) => <td key={i} style={align(i)}>{inline(cell.tokens, links)}</td>)}</tr>)}</tbody>}
  </table></div>;
}

function blocks(tokens: Token[], links: ChatLinks | null, tight = false): ReactNode[] {
  return tokens.map((token, key) => {
    const t = token as Tokens.Generic;
    switch (token.type) {
      case 'space': case 'def': return null;
      case 'paragraph': return tight ? <Fragment key={key}>{inline(t.tokens, links)}</Fragment> : <p key={key}>{inline(t.tokens, links)}</p>;
      case 'text': return <Fragment key={key}>{t.tokens ? inline(t.tokens, links) : decode(t.text as string)}</Fragment>;
      case 'heading': { const Tag = `h${(token as Tokens.Heading).depth}` as 'h1'; return <Tag key={key}>{inline(t.tokens, links)}</Tag>; }
      case 'code': { const lang = (token as Tokens.Code).lang?.split(/\s/)[0]; return <div key={key} className="code-block"><button type="button" className="code-copy">Copy</button><pre data-lang={lang}><code className={lang ? `language-${lang}` : undefined}>{(token as Tokens.Code).text}</code></pre></div>; }
      case 'blockquote': return <div key={key} className="code-block quote-block"><button type="button" className="code-copy">Copy</button><blockquote>{blocks(t.tokens ?? [], links)}</blockquote></div>;
      case 'hr': return <hr key={key}/>;
      case 'checkbox': return <input key={key} type="checkbox" checked={(token as Tokens.Checkbox).checked} disabled/>;
      case 'html': return <p key={key} className="plain-text">{t.text as string}</p>;
      case 'table': return table(token as Tokens.Table, key, links);
      case 'list': {
        const list = token as Tokens.List;
        const items = list.items.map((item, i) => <li key={i}>{blocks(item.tokens, links, !list.loose)}</li>);
        return list.ordered ? <ol key={key} start={list.start !== '' && list.start !== 1 ? list.start : undefined}>{items}</ol> : <ul key={key}>{items}</ul>;
      }
      default: return <p key={key}>{t.raw}</p>;
    }
  });
}

export function MessageMarkdown({ text, source }: { text: string; source: MarkdownSource }) {
  const links = useContext(ChatLinkContext);
  const rendered = useMemo(() => { const emotes = onlyEmoji(text); return emotes ? <p className="emotes">{emotes.map((e, i) => <img key={i} src={emojiSrc(e.name, 'big')} alt={e.code}/>)}</p> : blocks(Lexer.lex(text, options[source]), links); }, [text, source, links]);
  return <>{rendered}</>;
}
