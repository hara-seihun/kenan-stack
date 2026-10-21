import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { MessageMarkdown, type MarkdownSource } from './MessageMarkdown.js';

const render = (text: string, source: MarkdownSource = 'agent') => renderToStaticMarkup(createElement(MessageMarkdown, { text, source }));
const table = 'Compare:\n| Option | Cost |\n|---|---|\n| A | $10 |';

describe('MessageMarkdown', () => {
  it.each(['agent', 'human'] as const)('renders GFM pipe tables from %s messages inside a sideways-scrolling container', source => {
    const html = render(table, source);
    expect(html).toMatch(/<div [^>]*class="table-scroll"[^>]*><table style="min-width:11em;?"><thead>/);
    expect(html).not.toContain('|---|');
  });
  it('shows raw HTML as text and refuses script links', () => {
    const html = render('<img src=x onerror=alert(1)> [go](javascript:alert(1)) [ok](https://kenan.example.com) &amp;');
    expect(html).not.toContain('<img');
    expect(html).toContain('&lt;img src=x onerror=alert(1)>');
    expect(html).not.toContain('javascript:');
    expect(html).toContain('<a href="https://kenan.example.com">ok</a>');
    expect(html).toMatch(/ &amp;<\/p>$/);
  });
  it('breaks single newlines only in what people typed', () => {
    expect(render('a\nb', 'human')).toBe('<p>a<br/>b</p>');
    expect(render('a\nb', 'agent')).toBe('<p>a\nb</p>');
  });
  it('renders task lists and tight lists without paragraphs', () => {
    expect(render('- [x] done\n- item')).toBe('<ul><li><input type="checkbox" checked disabled/>done</li><li>item</li></ul>');
  });
});
