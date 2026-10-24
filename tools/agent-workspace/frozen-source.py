#!/usr/bin/python3
"""Privileged opt-in SOURCE-snapshot freeze. Never a build-root operation.
Root/sudo is an operator, not an adversary. No symlink traversal or bulk chattr.
"""
import array, fcntl, hashlib, json, os, stat, sys, time
GET=0x80086601; SET=0x40086602; IMMUTABLE=0x10

def identity(s): return [s.st_dev,s.st_ino,stat.S_IFMT(s.st_mode)]
def flags(fd):
    a=array.array('L',[0]); fcntl.ioctl(fd,GET,a,True); return a[0]
def setflags(fd,value): fcntl.ioctl(fd,SET,array.array('L',[value]),True)

def save_journal(file,data):
    temporary=file+'.next'
    fd=os.open(temporary,os.O_WRONLY|os.O_CREAT|os.O_TRUNC|os.O_NOFOLLOW,0o600)
    try:
        with os.fdopen(fd,'w') as stream:
            json.dump(data,stream);stream.flush();os.fsync(stream.fileno())
        os.replace(temporary,file)
        parent=os.open(os.path.dirname(file),os.O_RDONLY)
        try:os.fsync(parent)
        finally:os.close(parent)
    finally:
        if os.path.exists(temporary):os.unlink(temporary)

def rollback(file,root,expected):
    with open(file) as stream:data=json.load(stream)
    if data['root']!=root or data['identity']!=expected or identity(os.lstat(root))[:2]!=expected:raise ValueError('rollback custody mismatch')
    for p,ident,before in reversed(data['flags']):
        fd=os.open(p,os.O_RDONLY|os.O_NOFOLLOW|os.O_NONBLOCK)
        try:
            if identity(os.fstat(fd))!=ident:raise ValueError('rollback inode changed')
            if not before&IMMUTABLE:setflags(fd,flags(fd)&~IMMUTABLE)
        finally:os.close(fd)
    data['state']='rolled-back';save_journal(file,data)
    return {'state':'rolled-back','root':root}

def freeze(root,expected,owner_uid,max_entries=50000,inject=None,journal=None):
    deadline=time.monotonic()+20
    root=os.path.abspath(root)
    if os.path.realpath(root)!=root: raise ValueError('snapshot path must be canonical')
    rs=os.lstat(root)
    if identity(rs)[:2]!=expected or not stat.S_ISDIR(rs.st_mode): raise ValueError('snapshot inode changed')
    # Reject nested bind mounts as well as device changes; st_dev alone misses binds.
    with open('/proc/self/mountinfo') as stream:
        for line in stream:
            mount=line.split()[4].replace('\\040',' ').replace('\\134','\\')
            if mount.startswith(root+'/'):raise ValueError('snapshot contains mount')
    entries=[]
    def walk(p):
        if time.monotonic()>deadline or len(entries)>=max_entries: raise ValueError('snapshot tree budget exceeded')
        s=os.lstat(p)
        if s.st_dev!=rs.st_dev or s.st_uid!=owner_uid: raise ValueError('snapshot mount/owner mismatch')
        if stat.S_ISLNK(s.st_mode):
            target=os.path.realpath(p)
            if not target.startswith(root+'/'): raise ValueError('external snapshot symlink')
        elif stat.S_ISDIR(s.st_mode):
            for name in sorted(os.listdir(p)): walk(os.path.join(p,name))
        elif not stat.S_ISREG(s.st_mode) or s.st_nlink!=1: raise ValueError('snapshot nonprivate inode')
        entries.append((p,identity(s)))
    walk(root)
    if not os.path.isdir(root+'/.git') or os.path.islink(root+'/.git'): raise ValueError('snapshot needs independent .git')
    for name in ['objects/info/alternates','commondir','gitdir']:
        if os.path.lexists(root+'/.git/'+name): raise ValueError('snapshot has shared Git custody')
    changed=[]
    if journal:
        original=[]
        for p,ident in entries:
            if stat.S_ISLNK(ident[2]):continue
            fd=os.open(p,os.O_RDONLY|os.O_NOFOLLOW|os.O_NONBLOCK)
            try:
                if identity(os.fstat(fd))!=ident:raise ValueError('snapshot inode raced')
                original.append([p,ident,flags(fd)])
            finally:os.close(fd)
        if os.path.exists(journal):
            with open(journal) as stream:prior=json.load(stream)
            if prior['root']!=root or prior['identity']!=expected:raise ValueError('snapshot journal conflict')
            if prior['state']!='rolled-back':
                if [[p,i] for p,i,f in prior['flags']]!=[[p,i] for p,i,f in original]:raise ValueError('snapshot journal tree changed; reconcile original rollback')
                original=prior['flags']
        save_journal(journal,{'root':root,'identity':expected,'state':'freezing','flags':original})
    try:
        for index,(p,ident) in enumerate(entries):
            if time.monotonic()>deadline:raise ValueError("snapshot mutation budget exceeded")
            if stat.S_ISLNK(ident[2]): continue # parent directory flag protects link inode/name
            fd=os.open(p,os.O_RDONLY|os.O_NOFOLLOW|os.O_NONBLOCK)
            try:
                current=os.fstat(fd)
                if identity(current)!=ident or (stat.S_ISREG(current.st_mode) and current.st_nlink!=1): raise ValueError('snapshot inode raced')
                before=flags(fd)
                if not before&IMMUTABLE:
                    # Record BEFORE ioctl: rollback also covers a successful ioctl followed by an error.
                    changed.append((p,ident,before))
                    setflags(fd,before|IMMUTABLE)
                if not flags(fd)&IMMUTABLE: raise ValueError('snapshot flag readback failed')
            finally: os.close(fd)
            if inject: inject(index,p)
        actual=[]
        old=entries; entries=[]; walk(root); actual=entries
        if actual!=old: raise ValueError('snapshot tree changed during freeze')
        if journal:
            with open(journal) as stream:data=json.load(stream)
            data['state']='frozen';save_journal(journal,data)
        return {'journal':journal,'kind':'immutable-source-snapshot','root':root,'device':rs.st_dev,'inode':rs.st_ino,'entries':len(entries),'ordinaryWritesProtected':True,'privilegedOperatorProtected':False}
    except BaseException:
        errors=[]
        for p,ident,before in reversed(changed):
            try:
                fd=os.open(p,os.O_RDONLY|os.O_NOFOLLOW|os.O_NONBLOCK)
                try:
                    if identity(os.fstat(fd))!=ident: raise ValueError('rollback inode changed')
                    # Clear ONLY the bit this invocation set; preserve every other current bit.
                    setflags(fd,flags(fd)&~IMMUTABLE)
                finally: os.close(fd)
            except BaseException as e: errors.append(str(e))
        if journal and not errors:rollback(journal,root,expected)
        if errors: raise RuntimeError('snapshot rollback incomplete: '+'; '.join(errors))
        raise

if __name__=='__main__':
    if os.geteuid()!=0: raise SystemExit('snapshot freeze requires privileged helper')
    request=json.load(sys.stdin)
    root=request['path'];expected=[request['device'],request['inode']]
    custody='/var/lib/agent-workspace/frozen-source'
    os.makedirs(custody,mode=0o700,exist_ok=True)
    if os.path.realpath(custody)!=custody or os.stat(custody).st_uid!=0 or stat.S_IMODE(os.stat(custody).st_mode)!=0o700:raise SystemExit('unsafe snapshot journal custody')
    journal=custody+'/'+hashlib.sha256(json.dumps([root,expected]).encode()).hexdigest()+'.json'
    lock=os.open(journal+'.lock',os.O_RDWR|os.O_CREAT|os.O_NOFOLLOW,0o600)
    fcntl.flock(lock,fcntl.LOCK_EX|fcntl.LOCK_NB)
    if request.get('kind')=='freeze-source-snapshot':result=freeze(root,expected,request['uid'],journal=journal)
    elif request.get('kind')=='rollback-source-snapshot':result=rollback(journal,root,expected)
    else:raise SystemExit('unsupported snapshot operation')
    print(json.dumps(result))
