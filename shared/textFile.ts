// Which files the app reads in place: Markdown rendered, other text as monospace. One rule for the server (the MIME it
// stores) and the app (which attachments open the reader): files often arrive as application/octet-stream, and older
// ones were stored that way, so the name decides first.
export type TextKind = 'markdown' | 'text';

const MARKDOWN = /\.(md|markdown|mdx)$/i;
const TEXT = /(\.(txt|log|out|jsonl?|ipynb|ya?ml|toml|ini|cfg|conf|env|csv|tsv|xml|sh|bash|py|[cm]?[jt]sx?|css|sql|rs|go|[ch](pp)?|cc|hh|cuh?|java|kt|swift|rb|lua|r|jl|lean|tex|bib|diff|patch|nix|hs|ml|proto|srt|vtt|rst|org|lock|sum|mod)|(^|\/)(makefile|dockerfile|\.?gitignore))$/i;
const TEXT_MIME = /^(text\/(?!html)|application\/([\w.+-]*json|xml|ya?ml|toml|javascript|x-sh|sql)\b)/i;

/** How the app reads a file in place, or null when it is not text the reader shows (HTML has its own viewer). */
export const textKind = (name: string, mime: string): TextKind | null =>
  MARKDOWN.test(name) || /^text\/(x-)?markdown/i.test(mime) ? 'markdown' : /\.html?$/i.test(name) ? null : TEXT.test(name) || TEXT_MIME.test(mime) ? 'text' : null;

/** The MIME to store for a text file by name, or null when the name says nothing (the caller keeps its own type). */
export const textMime = (name: string): string | null =>
  MARKDOWN.test(name) ? 'text/markdown; charset=utf-8' : /\.(json|ipynb)$/i.test(name) ? 'application/json' : TEXT.test(name) ? 'text/plain; charset=utf-8' : null;
