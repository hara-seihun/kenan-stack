import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

// Attachment discovery and saving run offline on a constructed message: no Bridge, no mailbox.
const script = String.raw`
import email, importlib.machinery, json, os, sys, tempfile
from email.message import EmailMessage
sys.path.insert(0, sys.argv[1])
ms = importlib.machinery.SourceFileLoader('ms', os.path.join(sys.argv[1], 'mail-search')).load_module()
msg = EmailMessage()
msg['Subject'] = 'Permis'
msg.set_content('Body text')
msg.add_attachment(b'%PDF-1', maintype='application', subtype='pdf', filename='Demande de permis é.pdf')
msg.add_attachment(b'evil', maintype='application', subtype='octet-stream', filename='../../.bashrc')
msg.add_attachment(b'second', maintype='application', subtype='pdf', filename='Demande de permis é.pdf')
inner = EmailMessage(); inner['Subject'] = 'Forwarded'; inner.set_content('inner')
msg.add_attachment(inner)
parsed = email.message_from_bytes(msg.as_bytes())
found = ms.attachments(parsed)
out = tempfile.mkdtemp()
saved = ms.save_attachments(found, os.path.join(out, 'new'))
again = ms.save_attachments(found, os.path.join(out, 'new'))
open(saved[0][0], 'wb').write(b'changed')
try:
    ms.save_attachments(found, os.path.join(out, 'new')); clash = None
except ms.MailIdentityError as error:
    clash = error.code
plain = EmailMessage(); plain.set_content('only text')
print(json.dumps({
    'names': [a.filename for a in found], 'types': [a.content_type for a in found],
    'inside': all(os.path.dirname(p) == os.path.join(out, 'new') for p, _ in saved),
    'idempotent': [p for p, _ in saved] == [p for p, _ in again], 'clash': clash,
    'plain': len(ms.attachments(email.message_from_bytes(plain.as_bytes()))),
}))
`;

describe('mail-search attachments', () => {
  it('names attachments safely and uniquely, keeps attached mail whole, and never overwrites', () => {
    const result = spawnSync('python3', ['-c', script, import.meta.dirname], { encoding: 'utf8' });
    expect(result.stderr).toBe('');
    expect(JSON.parse(result.stdout)).toEqual({
      names: ['Demande de permis é.pdf', '_.._.bashrc', 'Demande de permis é (2).pdf', 'Forwarded.eml'],
      types: ['application/pdf', 'application/octet-stream', 'application/pdf', 'message/rfc822'],
      inside: true, idempotent: true, clash: 'output-exists', plain: 0,
    });
  });
});
