"""IMAP UID identity shared by the account-owned mail commands."""
import re


class MailIdentityError(ValueError):
    def __init__(self, code, message):
        self.code = code
        super().__init__(f'{code}: {message}')


def positive(value):
    return bool(re.fullmatch(r'[1-9][0-9]*', value)) and int(value) <= 4294967295


def parse_reference(value):
    parts = value.split(':')
    if len(parts) == 1 and positive(parts[0]):
        return None, parts[0]
    if len(parts) == 2 and all(positive(part) for part in parts):
        return parts[0], parts[1]
    raise MailIdentityError('invalid-reference', 'Use UID or UIDVALIDITY:UID, never a historical sequence number')


def parse_position(value):
    """A folder's position, UIDVALIDITY:UID of its newest message; UID 0 is an empty folder's."""
    validity, _, uid = value.partition(':')
    if positive(validity) and re.fullmatch(r'0|[1-9][0-9]*', uid) and int(uid) <= 4294967295:
        return validity, uid
    raise MailIdentityError('invalid-reference', 'a position is UIDVALIDITY:UID, as an earlier wait or search printed it')


def uidvalidity(connection):
    _, values = connection.response('UIDVALIDITY')
    if not values or len(values) != 1 or not isinstance(values[0], bytes):
        raise MailIdentityError('missing-uidvalidity', 'Selected mailbox did not supply UIDVALIDITY')
    value = values[0].decode('ascii').strip()
    if not positive(value):
        raise MailIdentityError('invalid-uidvalidity', 'Selected mailbox supplied invalid UIDVALIDITY')
    return value


def fetch_message(connection, reference, validity, section):
    expected, uid = parse_reference(reference)
    if expected is not None and expected != validity:
        raise MailIdentityError('uidvalidity-changed', 'Mailbox identity changed; find the message again by Message-ID')
    status, data = connection.uid('FETCH', uid, f'(UID {section})')
    if status != 'OK':
        raise MailIdentityError('fetch-failed', f'UID FETCH failed for {validity}:{uid}')
    literals = [part for part in data or [] if isinstance(part, tuple)]
    if not literals:
        raise MailIdentityError('message-missing', f'Message {validity}:{uid} is absent; find it again by Message-ID')
    if len(literals) != 1:
        raise MailIdentityError('ambiguous-fetch', 'Expected exactly one message literal')
    metadata, content = literals[0]
    found = re.search(rb'\bUID ([0-9]+)\b', metadata)
    if found is None or found[1].decode() != uid or not isinstance(content, bytes):
        raise MailIdentityError('identity-mismatch', 'UID FETCH returned a different or unbound message')
    return content



def fetch_messages(connection, uids, validity, section):
    """One UID FETCH for many UIDs: {uid: content} for every message present; absent UIDs are simply not in it."""
    if not uids:
        return {}
    status, data = connection.uid('FETCH', ','.join(uids), f'(UID {section})')
    if status != 'OK':
        raise MailIdentityError('fetch-failed', f'UID FETCH failed for {len(uids)} messages in {validity}')
    wanted = set(uids)
    found = {}
    for part in data or []:
        if not isinstance(part, tuple):
            continue
        metadata, content = part
        uid = re.search(rb'\bUID ([0-9]+)\b', metadata)
        if uid is None or uid[1].decode() not in wanted or not isinstance(content, bytes):
            raise MailIdentityError('identity-mismatch', 'UID FETCH returned a different or unbound message')
        if uid[1].decode() in found:
            raise MailIdentityError('ambiguous-fetch', f'UID FETCH returned {uid[1].decode()} twice')
        found[uid[1].decode()] = content
    return found

# The folder "*": every folder new mail can land in (mail-search arrival_folders).
ALL = "*"


def quote_box(box):
    # Python 3.14 imaplib no longer quotes mailbox names; "All Mail" must be quoted.
    return box if box.startswith('"') else '"' + box.replace('\\', '\\\\').replace('"', '\\"') + '"'


def listed_folders(m):
    """[(name, lower-cased flags)] for every folder the server lists."""
    found = []
    for line in m.list()[1]:
        if not isinstance(line, bytes):
            continue
        match = re.match(rb'\(([^)]*)\) (?:"(?:[^"\\]|\\.)*"|NIL) (?:"((?:[^"\\]|\\.)*)"|(\S+))$', line)
        if match:
            name = (match[2] if match[2] is not None else match[3]).decode().replace('\\"', '"').replace('\\\\', '\\')
            found.append((name, set(match[1].decode().lower().split())))
    return found


def folder_positions(m, folders):
    """{folder: (UIDVALIDITY, newest UID)} from STATUS, without selecting anything."""
    positions = {}
    for folder in folders:
        typ, data = m.status(quote_box(folder), "(UIDNEXT UIDVALIDITY)")
        line = data[0] if typ == "OK" and data and isinstance(data[0], bytes) else b""
        validity, uidnext = re.search(rb"UIDVALIDITY ([0-9]+)", line), re.search(rb"UIDNEXT ([0-9]+)", line)
        if not validity or not uidnext:
            raise MailIdentityError("folder-missing", f"cannot STATUS {folder}")
        positions[folder] = (validity[1].decode(), str(int(uidnext[1]) - 1))
    return positions


def locate(m, box, references):
    """[(folder, [references])] in first-seen order. FOLDER/UIDVALIDITY:UID names its folder; otherwise the folder given,
    unless the reference's UIDVALIDITY belongs to another folder (or the folder is "*"): then the folder whose UIDVALIDITY it is
    (each Proton Bridge folder has its own)."""
    by_validity, box_validity, groups = None, None, {}

    def owners(validity):
        nonlocal by_validity
        if by_validity is None:
            listed = [name for name, flags in listed_folders(m) if not flags & {"\\noselect", "\\nonexistent"}]
            by_validity = {}
            for name, (v, _) in folder_positions(m, listed).items():
                by_validity.setdefault(v, []).append(name)
        return by_validity.get(validity, [])

    for reference in references:
        folder, separator, bare = reference.rpartition("/")
        if not separator:
            folder, bare = box, reference
        validity, _ = parse_reference(bare)
        if folder == ALL:
            found = owners(validity) if validity is not None else []
            if len(found) != 1:
                raise MailIdentityError("folder-unknown", f"{reference}: " + (
                    "a bare UID needs its folder" if validity is None else
                    f"UIDVALIDITY {validity} belongs to several folders ({', '.join(found)}); pass folder" if found else
                    "no folder has this UIDVALIDITY now; search again"))
            folder = found[0]
        elif folder == box and validity is not None:
            if box_validity is None:
                box_validity = folder_positions(m, [box])[box][0]
            found = owners(validity) if validity != box_validity else []
            if len(found) == 1:
                folder = found[0]
        groups.setdefault(folder, []).append(bare)
    return list(groups.items())


ACCOUNT_SECURITY = ('tls', 'starttls')


def _endpoint(value, name):
    if not isinstance(value, dict) or set(value) != {'host', 'port', 'security'}:
        raise MailIdentityError('account-invalid', f'{name} needs exactly host, port and security')
    host, port, security = value['host'], value['port'], value['security']
    if not isinstance(host, str) or not host or not isinstance(port, int) or not 0 < port < 65536 or security not in ACCOUNT_SECURITY:
        raise MailIdentityError('account-invalid', f'{name} needs a host, a port and security tls|starttls')
    return host, port, security


def base_address(address):
    return re.sub(r'\+[^@]*@', '@', address.lower())


class Hosted:
    """A standard IMAP/SMTP mailbox: verified TLS, the account file lists every address it may send as."""
    kind = 'hosted'
    sent_copy = 'append'

    def __init__(self, path):
        import json
        with open(path, encoding='utf-8') as source:
            value = json.load(source)
        if not isinstance(value, dict) or set(value) != {'email', 'password', 'imap', 'smtp', 'addresses'}:
            raise MailIdentityError('account-invalid', 'Account file needs exactly email, password, imap, smtp and addresses')
        if not all(isinstance(value[key], str) and value[key] for key in ('email', 'password')):
            raise MailIdentityError('account-invalid', 'Account file needs a login email and password')
        owned = value['addresses']
        if not isinstance(owned, list) or not owned or any(not isinstance(item, str) or '@' not in item for item in owned):
            raise MailIdentityError('account-invalid', 'Account file needs a nonempty addresses list')
        self.user, self.password = value['email'], value['password']
        self.imap, self.smtp = _endpoint(value['imap'], 'imap'), _endpoint(value['smtp'], 'smtp')
        self.addresses = {base_address(item) for item in owned}

    def imap_connection(self):
        import imaplib, ssl
        host, port, security = self.imap
        context = ssl.create_default_context()
        if security == 'tls':
            connection = imaplib.IMAP4_SSL(host, port, ssl_context=context, timeout=30)
        else:
            connection = imaplib.IMAP4(host, port, timeout=30)
            connection.starttls(context)
        connection.login(self.user, self.password)
        return connection

    def smtp_connection(self):
        import smtplib, ssl
        host, port, security = self.smtp
        context = ssl.create_default_context()
        if security == 'tls':
            connection = smtplib.SMTP_SSL(host, port, context=context, timeout=30)
        else:
            connection = smtplib.SMTP(host, port, timeout=30)
            connection.starttls(context=context)
        connection.login(self.user, self.password)
        return connection

    def ownership(self):
        return lambda address: base_address(address) in self.addresses


PASS_ITEM = ['--vault-name', 'Agent', '--item-title', 'Proton Mail Bridge']


def bridge_cache_path():
    import os
    return os.path.join(os.path.expanduser('~'), '.local', 'state', 'kenan-mail', 'bridge-credential.json')


def read_bridge_cache(path):
    import json
    try:
        with open(path, encoding='utf-8') as source:
            value = json.load(source)
    except (OSError, ValueError):
        return None
    if isinstance(value, dict) and isinstance(value.get('email'), str) and isinstance(value.get('password'), str):
        return value['email'], value['password']
    return None


def write_bridge_cache(path, user, password):
    import json, os, tempfile
    directory = os.path.dirname(path)
    os.makedirs(directory, mode=0o700, exist_ok=True)
    descriptor, temporary = tempfile.mkstemp(dir=directory, prefix='.bridge-credential.')
    try:
        with os.fdopen(descriptor, 'w', encoding='utf-8') as target:
            json.dump({'email': user, 'password': password}, target)
        os.replace(temporary, path)
    except BaseException:
        os.unlink(temporary)
        raise


def pass_bridge_credential():
    import json, os, subprocess
    env = dict(os.environ)
    env.setdefault('PROTON_PASS_AGENT_REASON', 'Read Proton Bridge local mail-client credentials')
    try:
        result = subprocess.run(['pass-cli', 'item', 'view', *PASS_ITEM, '--output', 'json'],
                                capture_output=True, text=True, timeout=60, env=env)
    except (OSError, subprocess.TimeoutExpired) as error:
        raise MailIdentityError('bridge-credential-unavailable', f'Proton Pass did not return the Bridge credential ({type(error).__name__})') from None
    if result.returncode != 0:
        raise MailIdentityError('bridge-credential-unavailable', f'pass-cli exited {result.returncode}')
    try:
        value = json.loads(result.stdout)['item']['content']['content']['Login']
        return value['email'], value['password']
    except (ValueError, KeyError, TypeError):
        raise MailIdentityError('bridge-credential-unavailable', 'pass-cli returned no Login email and password') from None


class Bridge:
    """The owning account's Proton Mail Bridge: loopback STARTTLS with Bridge's self-signed certificate.

    Without an explicit credential file the Bridge client login comes from a user-only cache
    (~/.local/state/kenan-mail/bridge-credential.json), filled from Proton Pass when it is missing
    and refreshed from Proton Pass only when Bridge refuses the cached login."""
    kind = 'bridge'
    sent_copy = 'provider'

    def __init__(self, path):
        import json, os
        if path:
            with open(path, encoding='utf-8') as source:
                value = json.load(source)
            self.user, self.password = value.get('email', value.get('username')), value['password']
            self.cache = None
        else:
            self.cache = bridge_cache_path()
            cached = read_bridge_cache(self.cache)
            if cached:
                self.user, self.password = cached
                self.refreshable = True
            else:
                self.refresh()
        self._smtp_ready = None
        self.imap_port = int(os.environ.get('MAIL_BRIDGE_IMAP_PORT', '1143'))
        self.smtp_port = int(os.environ.get('MAIL_BRIDGE_SMTP_PORT', '1025'))

    def refresh(self):
        self.user, self.password = pass_bridge_credential()
        write_bridge_cache(self.cache, self.user, self.password)
        self.refreshable = False

    def logged_in(self, attempt, refused):
        """Refresh a rejected credential once; an unavailable Bridge is not a stale credential."""
        def login():
            try:
                return attempt()
            except ConnectionRefusedError:
                raise MailIdentityError('bridge-not-ready', 'Bridge is not accepting connections; its account must finish starting before mail can be used') from None
            except refused as error:
                reply = str(error).casefold()
                if 'no such user' in reply or 'too many login attempts' in reply:
                    raise MailIdentityError('bridge-not-ready', 'Bridge has not loaded its account or is temporarily limiting logins; the stored credential was not changed') from None
                raise

        try:
            return login()
        except refused:
            if not (self.cache and self.refreshable):
                raise
        self.refresh()
        return login()

    @staticmethod
    def loopback_context():
        import ssl
        context = ssl.create_default_context()
        context.check_hostname = False
        context.verify_mode = ssl.CERT_NONE
        return context

    def imap_connection(self):
        import imaplib

        def attempt():
            connection = imaplib.IMAP4('127.0.0.1', self.imap_port, timeout=30)
            try:
                connection.starttls(self.loopback_context())
                connection.login(self.user, self.password)
            except BaseException:
                connection.shutdown()
                raise
            return connection
        return self.logged_in(attempt, imaplib.IMAP4.error)

    def smtp_login(self, user):
        import smtplib
        connection = smtplib.SMTP('127.0.0.1', self.smtp_port, timeout=30)
        try:
            connection.starttls(context=self.loopback_context())
            connection.login(user, self.password)
        except BaseException:
            connection.close()
            raise
        return connection

    def smtp_connection(self, user=None):
        """SMTP as the account (a refused cached login is refreshed), or as one of its addresses (refusal means not owned)."""
        import smtplib
        if user is None and self._smtp_ready is not None:
            connection, self._smtp_ready = self._smtp_ready, None
            return connection
        if user is None or user.lower() == self.user.lower():
            return self.logged_in(lambda: self.smtp_login(self.user), smtplib.SMTPAuthenticationError)
        return self.smtp_login(user)

    def ownership(self):
        """Bridge accepts its client password for every address of the account, so SMTP AUTH as an address proves ownership without sending."""
        import smtplib
        known = {self.user.lower(): True}

        def authenticates(address):
            try:
                connection = self.smtp_connection(address)
            except smtplib.SMTPAuthenticationError:
                return False
            # Keep the ownership check's authenticated connection for this send.
            # A draft closes it when the CLI exits; no second TLS/AUTH is needed.
            if self._smtp_ready is not None:
                self._smtp_ready.close()
            self._smtp_ready = connection
            return True

        def owned(address):
            account = base_address(address)
            if account not in known:
                known[account] = authenticates(account)
                if not known[account]:
                    tried = self.password
                    if not authenticates(self.user):
                        raise MailIdentityError('bridge-auth-failed', 'Bridge refused its own client login; cannot check sender ownership')
                    if self.password != tried:
                        known[account] = authenticates(account)
            return known[account]
        return owned


def load_account():
    """MAIL_ACCOUNT_FILE names a hosted IMAP/SMTP mailbox; otherwise the owner's Proton Bridge (MAIL_BRIDGE_CREDENTIAL_FILE, else the Pass-filled local cache)."""
    import os
    hosted = os.environ.get('MAIL_ACCOUNT_FILE')
    if hosted and os.environ.get('MAIL_BRIDGE_CREDENTIAL_FILE'):
        raise MailIdentityError('account-ambiguous', 'Set MAIL_ACCOUNT_FILE or MAIL_BRIDGE_CREDENTIAL_FILE, not both')
    if hosted:
        return Hosted(hosted)
    return Bridge(os.environ.get('MAIL_BRIDGE_CREDENTIAL_FILE'))
