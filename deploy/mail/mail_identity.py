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


class Bridge:
    """The owning account's Proton Mail Bridge: loopback STARTTLS with Bridge's self-signed certificate."""
    kind = 'bridge'
    sent_copy = 'provider'

    def __init__(self, path):
        import json, os, subprocess
        if path:
            with open(path, encoding='utf-8') as source:
                value = json.load(source)
            self.user, self.password = value.get('email', value.get('username')), value['password']
        else:
            env = dict(os.environ)
            env.setdefault('PROTON_PASS_AGENT_REASON', 'Read Proton Bridge local mail-client credentials')
            result = subprocess.run(['pass-cli', 'item', 'view', '--vault-name', 'Agent', '--item-title', 'Proton Mail Bridge', '--output', 'json'],
                                    capture_output=True, text=True, check=True, timeout=15, env=env)
            value = json.loads(result.stdout)['item']['content']['content']['Login']
            self.user, self.password = value['email'], value['password']
        self.imap_port = int(os.environ.get('MAIL_BRIDGE_IMAP_PORT', '1143'))
        self.smtp_port = int(os.environ.get('MAIL_BRIDGE_SMTP_PORT', '1025'))

    @staticmethod
    def loopback_context():
        import ssl
        context = ssl.create_default_context()
        context.check_hostname = False
        context.verify_mode = ssl.CERT_NONE
        return context

    def imap_connection(self):
        import imaplib
        connection = imaplib.IMAP4('127.0.0.1', self.imap_port, timeout=30)
        connection.starttls(self.loopback_context())
        connection.login(self.user, self.password)
        return connection

    def smtp_connection(self, user=None):
        import smtplib
        connection = smtplib.SMTP('127.0.0.1', self.smtp_port, timeout=30)
        try:
            connection.starttls(context=self.loopback_context())
            connection.login(user or self.user, self.password)
        except BaseException:
            connection.close()
            raise
        return connection

    def ownership(self):
        """Bridge accepts its client password for every address of the account, so SMTP AUTH as an address proves ownership without sending."""
        import smtplib
        known = {self.user.lower(): True}

        def authenticates(address):
            try:
                connection = self.smtp_connection(address)
            except smtplib.SMTPAuthenticationError:
                return False
            try:
                connection.quit()
            except Exception:
                connection.close()
            return True

        def owned(address):
            account = base_address(address)
            if account not in known:
                known[account] = authenticates(account)
                if not known[account] and not authenticates(self.user):
                    raise MailIdentityError('bridge-auth-failed', 'Bridge refused its own client login; cannot check sender ownership')
            return known[account]
        return owned


def load_account():
    """MAIL_ACCOUNT_FILE names a hosted IMAP/SMTP mailbox; otherwise the owner's Proton Bridge (MAIL_BRIDGE_CREDENTIAL_FILE, else Proton Pass)."""
    import os
    hosted = os.environ.get('MAIL_ACCOUNT_FILE')
    if hosted and os.environ.get('MAIL_BRIDGE_CREDENTIAL_FILE'):
        raise MailIdentityError('account-ambiguous', 'Set MAIL_ACCOUNT_FILE or MAIL_BRIDGE_CREDENTIAL_FILE, not both')
    if hosted:
        return Hosted(hosted)
    return Bridge(os.environ.get('MAIL_BRIDGE_CREDENTIAL_FILE'))
