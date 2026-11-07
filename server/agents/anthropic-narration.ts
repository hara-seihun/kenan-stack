import type { AssistantMessage } from "@earendil-works/pi-ai";

function signatureFields(bytes: Uint8Array) {
  let offset = 0;
  const varint = () => {
    let value = 0;
    for (let shift = 0; shift < 53 && offset < bytes.length; shift += 7) {
      const byte = bytes[offset++]!;
      value += (byte & 127) * 2 ** shift;
      if (!Number.isSafeInteger(value)) return null;
      if (byte < 128) return value;
    }
    return null;
  };
  const fields: { number: number; bytes?: Uint8Array }[] = [];
  while (offset < bytes.length) {
    const key = varint();
    if (key === null || key < 8) return null;
    const number = Math.floor(key / 8);
    const wire = key % 8;
    if (wire === 0) {
      if (varint() === null) return null;
      fields.push({ number });
    } else if (wire === 2) {
      const length = varint();
      if (length === null || length > bytes.length - offset) return null;
      fields.push({ number, bytes: bytes.subarray(offset, offset + length) });
      offset += length;
    } else if (wire === 1 || wire === 5) {
      offset += wire === 1 ? 8 : 4;
      if (offset > bytes.length) return null;
      fields.push({ number });
    } else return null;
  }
  return fields;
}

/** Anthropic's signed envelope identifies its channel at protobuf field 2.1.8. */
export function anthropicSignatureChannel(signature: unknown) {
  const unrecognized = { kind: "unrecognized", channel: undefined };
  if (typeof signature !== "string" || !signature || signature.length > 65_536
    || !/^[A-Za-z0-9+/]+={0,2}$/.test(signature) || signature.length % 4 === 1) return unrecognized;
  let bytes;
  try { bytes = Uint8Array.from(atob(signature), character => character.charCodeAt(0)); }
  catch { return unrecognized; }
  for (const fieldNumber of [2, 1, 8]) {
    const fields = signatureFields(bytes);
    if (!fields) return unrecognized;
    const matches = fields.filter(field => field.number === fieldNumber);
    if (matches.length !== 1 || !matches[0]!.bytes) return unrecognized;
    bytes = matches[0]!.bytes;
  }
  const channel = new TextDecoder().decode(bytes);
  return channel === "narration" || channel === "thinking"
    ? { kind: "channel", channel } : unrecognized;
}

/** Anthropic returns public narration in a signed thinking envelope. The channel, not its position before a tool,
 * identifies it as words for the person. Keep the original envelope in Pi for signed replay; project only for display
 * and compaction. Unknown signatures and genuine thinking remain thinking. This does not call a summarizer. */
export function displayContent(message: Pick<AssistantMessage, 'api' | 'content'>): AssistantMessage['content'] {
  if (message.api !== 'anthropic-messages') return message.content;
  return message.content.map(block => block.type === 'thinking' && anthropicSignatureChannel(block.thinkingSignature).channel === 'narration'
    ? { type: 'text' as const, text: block.thinking } : block);
}
