// Pi's text classifier retries "Provider returned error" even when the provider explicitly
// returned HTTP 400. Preserve client rejection statuses instead of spending all eight retries
// resending a request the provider rejected. HTTP 408, 409 and 429 remain transient.
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const file = join(process.cwd(), 'node_modules/@earendil-works/pi-ai/dist/utils/retry.js');
const source = readFileSync(file, 'utf8');
const marker = '/* kenan: explicit client rejection is not a transient provider error */';
const original = '    const errorMessage = message.errorMessage;';
const replacement = `${original}
    ${marker}
    const status = /^(?:HTTP\\s+)?(4\\d{2})(?=[:\\s]|$)/i.exec(errorMessage.trim());
    if (status && ![408, 409, 429].includes(Number(status[1]))) return false;`;
if (!source.includes(marker)) {
  if (source.split(original).length !== 2) throw new Error(`pi-ai-retry: ${file} no longer matches pi-ai 1.1.0; update the explicit HTTP status classification.`);
  writeFileSync(file, source.replace(original, replacement));
}
