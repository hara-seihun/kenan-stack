// pi-ai re-parses a tool call's whole argument text on every streamed delta, so a tool call with megabytes of arguments
// costs time quadratic in its size and holds the server's event loop for minutes (Beta hung 2026-10-29 at 14:01 PT).
// This makes long partial parses amortised linear: each stream keeps a running bracket/string state over only the new
// characters, re-parses the partial text once it has grown by a quarter, and parses in full (with pi-ai's repair) the
// moment the top-level value is complete, so final arguments are exact. Applied by `postinstall`; an unrecognised pi-ai
// fails the install so an upgrade gets looked at. Amortised from 1 KiB up (2026-10-31: below the earlier 16 KiB threshold the
// per-delta full parse, mostly thrown-and-repaired partial JSON, still cost 6 % of Beta's event loop).
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const original = `export function parseStreamingJson(partialJson) {
    if (!partialJson || partialJson.trim() === "") {
        return {};
    }
    try {`;
const marker = '/* kenan: amortised streaming parse */';
const replacement = `${marker}
const STREAM_PARSE_MIN = 1024;
const streams = [];
function streamOf(text) {
    for (let index = 0; index < streams.length; index++) {
        const entry = streams[index];
        if (text.length >= entry.length && text.startsWith(entry.tail, entry.length - entry.tail.length)) {
            streams.splice(index, 1);
            streams.unshift(entry);
            return entry;
        }
    }
    const entry = { length: 0, tail: "", depth: 0, opened: false, inString: false, escaped: false, parsedLength: 0, value: {} };
    streams.unshift(entry);
    if (streams.length > 32) streams.pop();
    return entry;
}
function advance(entry, text) {
    for (let index = entry.length; index < text.length; index++) {
        const code = text.charCodeAt(index);
        if (entry.inString) {
            if (entry.escaped) entry.escaped = false;
            else if (code === 92) entry.escaped = true;
            else if (code === 34) entry.inString = false;
        }
        else if (code === 34) entry.inString = true;
        else if (code === 123 || code === 91) { entry.depth++; entry.opened = true; }
        else if (code === 125 || code === 93) entry.depth--;
    }
    entry.length = text.length;
    entry.tail = text.slice(-64);
}
export function parseStreamingJson(partialJson) {
    if (!partialJson || partialJson.trim() === "") {
        return {};
    }
    if (partialJson.length < STREAM_PARSE_MIN) return parseStreamingJsonNow(partialJson);
    const entry = streamOf(partialJson);
    advance(entry, partialJson);
    const complete = entry.opened && entry.depth <= 0 && !entry.inString;
    if (complete || partialJson.length >= entry.parsedLength + (entry.parsedLength >> 2)) {
        entry.value = parseStreamingJsonNow(partialJson);
        entry.parsedLength = partialJson.length;
    }
    return entry.value;
}
function parseStreamingJsonNow(partialJson) {
    if (!partialJson || partialJson.trim() === "") {
        return {};
    }
    try {`;

const file = join(process.cwd(), 'node_modules/@earendil-works/pi-ai/dist/utils/json-parse.js');
const source = readFileSync(file, 'utf8');
if (source.includes(marker)) process.exit(0);
if (source.split(original).length !== 2) {
  console.error(`pi-ai-streaming-json: ${file} no longer matches the patched pi-ai 1.1.0; check whether the quadratic streaming parse is still there and update deploy/patches/pi-ai-streaming-json.mjs`);
  process.exit(1);
}
writeFileSync(file, source.replace(original, replacement));
