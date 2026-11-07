/** A bounded head-and-tail preview. The complete bytes stay in the named file. */
export function outputPreview(head: Buffer, tail: Buffer, totalBytes: number, path: string, totalLines?: number): string {
  // Do not print a replacement character just because a UTF-8 sequence crosses a cut.
  let lastStart = head.length - 1, start = 0;
  while (lastStart >= 0 && (head[lastStart]! & 0xc0) === 0x80) lastStart--;
  const lead = head[lastStart] ?? 0;
  const width = lead >= 0xf0 ? 4 : lead >= 0xe0 ? 3 : lead >= 0xc0 ? 2 : 1;
  const end = lastStart + width > head.length ? Math.max(0, lastStart) : head.length;
  while (start < tail.length && (tail[start]! & 0xc0) === 0x80) start++;
  const first = head.subarray(0, end), last = tail.subarray(start);
  const omitted = totalBytes - first.length - last.length;
  const shownBreaks = (first.toString().match(/\n/g)?.length ?? 0) + (last.toString().match(/\n/g)?.length ?? 0);
  const lines = totalLines === undefined ? '' : `; ${Math.max(0, totalLines - 1 - shownBreaks)} line breaks omitted`;
  return `${first.toString()}\n\n[${omitted} bytes omitted${lines}. Full output: ${path}.]\n\n${last.toString()}`;
}
