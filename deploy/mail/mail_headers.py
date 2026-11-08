"""Local header search for Bridge folders.

Proton Bridge answers any IMAP search on FROM, TO, CC or SUBJECT by scanning the whole folder (about 4 s of CPU on a
7,000 message folder, whatever else the query says), and mail wakes ask every minute. UIDs never change inside one
UIDVALIDITY, so each header is fetched once into a local SQLite cache and those four keys are answered from it. TEXT/BODY are searched in a separate compressed MIME literal cache; only metadata keys go to the server. The results are combined here with the query's own AND/OR/NOT.
"""
import fcntl, hashlib, json, os, sqlite3, zlib
from email import message_from_bytes
from email.header import decode_header, make_header

from mail_identity import fetch_messages

LOCAL = {"FROM": "from", "TO": "to", "CC": "cc", "SUBJECT": "subject"}
ONE_OPERAND = set("BCC BODY CC FROM SUBJECT TEXT TO BEFORE ON SENTBEFORE SENTON SENTSINCE SINCE LARGER SMALLER KEYWORD UNKEYWORD UID".split())
FETCH_BATCH = 500


def cache_path():
    root = os.environ.get("XDG_CACHE_HOME") or os.path.join(os.path.expanduser("~"), ".cache")
    return os.path.join(root, "kenan-mail", "headers.sqlite")


def text(value):
    try:
        return str(make_header(decode_header(value or ""))).casefold()
    except Exception:
        return (value or "").casefold()


def tree(tokens):
    """Tokens of the normalised IMAP expression -> ('and', [..]) | ('or', a, b) | ('not', a) | ('leaf', name, operands)."""
    index = 0

    def take():
        nonlocal index
        token = tokens[index]
        index += 1
        return token

    def node():
        word, quoted = take()
        if quoted:
            raise ValueError("quoted string where a key belongs")
        name = word.upper()
        if name == "(":
            parts = []
            while tokens[index] != (")", False):
                parts.append(node())
            take()
            return ("and", parts)
        if name == "OR":
            return ("or", node(), node())
        if name == "NOT":
            return ("not", node())
        if name == "HEADER":
            return ("leaf", name, [take(), take()])
        if name in ONE_OPERAND:
            return ("leaf", name, [take()])
        return ("leaf", name, [])

    parts = []
    while index < len(tokens):
        parts.append(node())
    return ("and", parts)


def uses_local(node):
    if node[0] == "leaf":
        return node[1] in LOCAL or node[1] in {"TEXT", "BODY", "HEADER", "BCC"}
    return any(uses_local(child) for child in (node[1] if node[0] == "and" else node[1:]))


def emit(name, operands):
    return " ".join([name] + ['"' + v.replace("\\", "\\\\").replace('"', '\\"') + '"' if quoted else v for v, quoted in operands])


class Headers:
    def __init__(self, connection, validity, folder):
        path = cache_path()
        os.makedirs(os.path.dirname(path), mode=0o700, exist_ok=True)
        self.db = sqlite3.connect(path, timeout=60)
        self.db.execute("PRAGMA journal_mode=WAL")
        self.db.execute("CREATE TABLE IF NOT EXISTS h(validity TEXT, folder TEXT, uid INTEGER, from_ TEXT, to_ TEXT, cc TEXT, subject TEXT, PRIMARY KEY(validity, folder, uid)) WITHOUT ROWID")
        self.connection, self.validity, self.folder = connection, str(validity), folder

    def load(self, universe):
        """{uid: {from,to,cc,subject}} for every UID in the universe, fetching only those not cached yet."""
        have = {row[0]: row[1:] for row in self.db.execute("SELECT uid, from_, to_, cc, subject FROM h WHERE validity=? AND folder=?", (self.validity, self.folder))}
        missing = sorted(uid for uid in universe if uid not in have)
        for start in range(0, len(missing), FETCH_BATCH):
            batch = missing[start:start + FETCH_BATCH]
            fetched = fetch_messages(self.connection, [str(uid) for uid in batch], self.validity, "BODY.PEEK[HEADER.FIELDS (FROM TO CC SUBJECT)]")
            rows = []
            for uid in batch:
                if str(uid) not in fetched:
                    continue
                message = message_from_bytes(fetched[str(uid)])
                row = tuple(text(message.get(field)) for field in ("From", "To", "Cc", "Subject"))
                have[uid] = row
                rows.append((self.validity, self.folder, uid) + row)
            with self.db:
                self.db.executemany("INSERT OR IGNORE INTO h VALUES (?,?,?,?,?,?,?)", rows)
        return {uid: dict(zip(("from", "to", "cc", "subject"), have[uid])) for uid in universe if uid in have}




class Content:
    """Immutable UID content, fetched once, never searched by Bridge.

    Cold callers share each small UID batch rather than starting duplicate decryptions.
    The lock covers only filling that batch; cached searches and header searches never wait for it.
    """
    BATCH = 4

    def __init__(self, connection, validity, folder):
        path = cache_path()
        os.makedirs(os.path.dirname(path), mode=0o700, exist_ok=True)
        self.db = sqlite3.connect(path, timeout=30)
        self.db.execute("PRAGMA journal_mode=WAL")
        self.db.execute("CREATE TABLE IF NOT EXISTS literals(validity TEXT, folder TEXT, uid INTEGER, data BLOB, PRIMARY KEY(validity, folder, uid)) WITHOUT ROWID")
        self.connection, self.validity, self.folder = connection, str(validity), folder
        self.locks = path + ".fills"
        os.makedirs(self.locks, mode=0o700, exist_ok=True)

    def ensure(self, universe):
        # Query only the requested UID range; narrowing dates must not load unrelated large bodies.
        if not universe:
            return
        def cached():
            return {row[0] for row in self.db.execute(
                "SELECT uid FROM literals WHERE validity=? AND folder=? AND uid BETWEEN ? AND ?",
                (self.validity, self.folder, min(universe), max(universe))) if row[0] in universe}
        have = cached()
        buckets = sorted({uid // self.BATCH for uid in universe if uid not in have})
        # Folder is encoded reversibly into a safe filename, not used as an identity check.
        folder_key = hashlib.blake2s(self.folder.encode(), digest_size=12).hexdigest()
        for bucket in buckets:
            with open(os.path.join(self.locks, f"{self.validity}-{folder_key}-{bucket}"), "a") as lock:
                fcntl.flock(lock, fcntl.LOCK_EX)
                # Another caller may have filled this batch while we read the preceding batch.
                rows = {row[0] for row in self.db.execute(
                    "SELECT uid FROM literals WHERE validity=? AND folder=? AND uid BETWEEN ? AND ?",
                    (self.validity, self.folder, bucket * self.BATCH, (bucket + 1) * self.BATCH - 1))}
                have.update(rows & universe)
                missing = sorted(uid for uid in universe if uid // self.BATCH == bucket and uid not in have)
                fetched = fetch_messages(self.connection, [str(uid) for uid in missing], self.validity, "BODY.PEEK[]")
                inserts = []
                for uid in missing:
                    if str(uid) not in fetched:
                        continue
                    have.add(uid)
                    inserts.append((self.validity, self.folder, uid, zlib.compress(fetched[str(uid)], level=1)))
                with self.db:
                    self.db.executemany("INSERT OR IGNORE INTO literals VALUES (?,?,?,?)", inserts)

    def matches(self, candidates, name, needle):
        self.ensure(candidates)
        rows = self.db.execute("SELECT uid, data FROM literals WHERE validity=? AND folder=? AND uid BETWEEN ? AND ?",
                               (self.validity, self.folder, min(candidates), max(candidates)))
        found = set()
        for uid, compressed in rows:
            if uid not in candidates:
                continue
            raw = zlib.decompress(compressed)
            if name == "BODY":
                raw = raw.partition(b"\r\n\r\n")[2] if b"\r\n\r\n" in raw else raw.partition(b"\n\n")[2]
            # Gluon searches the raw MIME literal, not decoded attachments or rendered HTML.
            if needle in raw.decode("utf-8", errors="replace").lower():
                found.add(uid)
        return found


def header_matches(connection, validity, folder, candidates, field, needle):
    """Arbitrary HEADER/BCC predicates fetch headers only, never full bodies."""
    path = cache_path()
    os.makedirs(os.path.dirname(path), mode=0o700, exist_ok=True)
    db = sqlite3.connect(path, timeout=30)
    db.execute("CREATE TABLE IF NOT EXISTS all_headers(validity TEXT, folder TEXT, uid INTEGER, fields TEXT, PRIMARY KEY(validity, folder, uid)) WITHOUT ROWID")
    have = {uid: json.loads(fields) for uid, fields in db.execute(
        "SELECT uid, fields FROM all_headers WHERE validity=? AND folder=?", (str(validity), folder))}
    missing = sorted(candidates - have.keys())
    for start in range(0, len(missing), FETCH_BATCH):
        fetched = fetch_messages(connection, [str(uid) for uid in missing[start:start + FETCH_BATCH]], validity, "BODY.PEEK[HEADER]")
        inserts = []
        for uid, raw in fetched.items():
            fields = {}
            for key, value in message_from_bytes(raw).items():
                fields.setdefault(key.casefold(), []).append(text(value))
            have[int(uid)] = fields
            inserts.append((str(validity), folder, int(uid), json.dumps(fields)))
        with db:
            db.executemany("INSERT OR IGNORE INTO all_headers VALUES (?,?,?,?)", inserts)
    db.close()
    return {uid for uid in candidates if uid in have and field in have[uid]
            and any(needle in value for value in have[uid][field])}


def search(connection, validity, folder, expression_tokens, search_error, scope=None):
    """UIDs matching the expression, or None when it has no key the cache can answer (the server then answers it all)."""
    root = tree(expression_tokens)
    if not uses_local(root):
        return None
    if scope is None:
        status, data = connection.uid("SEARCH", None, "ALL")
        if status != "OK":
            raise search_error("UID SEARCH ALL failed")
        universe = {int(uid) for uid in data[0].split()}
    else:
        universe = scope
        if not universe:
            return set()
    content = None

    def server(name, operands):
        expression = emit(name, operands)
        if scope is not None:
            expression = f"UID {min(scope)}:{max(scope)} ({expression})"
        status, data = connection.uid("SEARCH", None, expression)
        if status != "OK":
            raise search_error(f"UID SEARCH {name} failed")
        return {int(uid) for uid in data[0].split()} & universe

    def cost(node):
        if node[0] == "leaf":
            return 2 if node[1] in {"TEXT", "BODY", "HEADER", "BCC"} else 1 if node[1] in LOCAL else 0
        return max((cost(child) for child in (node[1] if node[0] == "and" else node[1:])), default=0)

    def evaluate(node, candidates):
        nonlocal content
        if not candidates:
            return set()
        if node[0] == "and":
            result = set(candidates)
            # Narrow by cheap metadata and headers before fetching full message bodies.
            for child in sorted(node[1], key=cost):
                result = evaluate(child, result)
            return result
        if node[0] == "or":
            left = evaluate(node[1], candidates)
            return left | evaluate(node[2], candidates - left)
        if node[0] == "not":
            return candidates - evaluate(node[1], candidates)
        _, name, operands = node
        if name in {"TEXT", "BODY", "HEADER", "BCC"}:
            needle = operands[-1][0].lower()
            if name in {"HEADER", "BCC"}:
                field = operands[0][0].casefold() if name == "HEADER" else "bcc"
                return header_matches(connection, validity, folder, candidates, field, needle)
            if content is None:
                content = Content(connection, validity, folder)
            return content.matches(candidates, name, needle)
        if name not in LOCAL:
            return server(name, operands) & candidates
        headers = Headers(connection, validity, folder).load(candidates)
        needle = operands[0][0].casefold()
        field = LOCAL[name]
        return {uid for uid, row in headers.items() if needle in row[field]}

    return evaluate(root, universe)
