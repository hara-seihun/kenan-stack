#!/usr/bin/python3
"""Bounded read-only immutable-bit observation; never changes flags or follows links."""
import array,ctypes,errno,fcntl,json,os,stat,struct,sys,time
# argv: PATH recursive|root BASE_SECONDS PER_ENTRY_SECONDS CAP_SECONDS. The allowed time grows with the entries seen,
# so a large tree is never refused for being large; only a pathologically slow observation is.
# Exit 3 means unknown; exit 4 means an entry could not be observed without read/search permission.
request={'path':sys.argv[1],'recursive':sys.argv[2]=='recursive'};base,per_entry,cap=(float(value) for value in sys.argv[3:6]);start=time.monotonic();count=0

# statx reports the immutable attribute from the inode without opening the file, so a file this
# account can't read (root-owned 0600 bytecode, for example) is still observed exactly.
AT_SYMLINK_NOFOLLOW=0x100;STATX_BASIC_STATS=0x7ff;STATX_ATTR_IMMUTABLE=0x10
libc=ctypes.CDLL(None,use_errno=True)
statx=getattr(libc,'statx',None)
if statx is not None:statx.argtypes=[ctypes.c_int,ctypes.c_char_p,ctypes.c_int,ctypes.c_uint,ctypes.c_void_p];statx.restype=ctypes.c_int
AT_FDCWD=-100

class Unobservable(Exception):pass

def immutable_by_statx(p):
 if statx is None:return None
 buffer=ctypes.create_string_buffer(256)
 if statx(AT_FDCWD,os.fsencode(p),AT_SYMLINK_NOFOLLOW,STATX_BASIC_STATS,buffer)!=0:
  code=ctypes.get_errno()
  if code in (errno.EACCES,errno.EPERM):raise Unobservable(p)
  raise OSError(code,os.strerror(code),p)
 attributes,=struct.unpack_from('<Q',buffer,8);supported,=struct.unpack_from('<Q',buffer,56)
 if not supported&STATX_ATTR_IMMUTABLE:return None
 return bool(attributes&STATX_ATTR_IMMUTABLE)

def immutable_by_ioctl(p,st):
 try:fd=os.open(p,os.O_RDONLY|os.O_NOFOLLOW|os.O_NONBLOCK)
 except PermissionError:raise Unobservable(p)
 try:
  current=os.fstat(fd)
  if (current.st_dev,current.st_ino)!=(st.st_dev,st.st_ino):raise RuntimeError('inode changed')
  flags=array.array('L',[0])
  try:fcntl.ioctl(fd,0x80086601,flags,True)
  except OSError as error:
   if error.errno not in (errno.ENOTTY,errno.EOPNOTSUPP):raise
  return bool(flags[0]&0x10)
 finally:os.close(fd)

def visit(p):
 global count
 count+=1
 elapsed=time.monotonic()-start
 if elapsed>min(cap,base+per_entry*count):raise RuntimeError('immutable observation budget exhausted after %d entries in %.1fs'%(count,elapsed))
 try:st=os.lstat(p)
 except PermissionError:raise Unobservable(p)
 if stat.S_ISLNK(st.st_mode):return None
 if not(stat.S_ISDIR(st.st_mode) or stat.S_ISREG(st.st_mode)):return None
 immutable=immutable_by_statx(p)
 if immutable is None:immutable=immutable_by_ioctl(p,st)
 if immutable:return p
 if request.get('recursive') and stat.S_ISDIR(st.st_mode):
  try:entries=os.scandir(p)
  except PermissionError:raise Unobservable(p)
  with entries:
   for entry in entries:
    result=visit(entry.path)
    if result:return result
 return None
try:result=visit(request['path'])
except Unobservable as error:
 sys.stderr.write('unreadable: %s\n'%error);sys.exit(4)
except Exception as error:
 sys.stderr.write('unknown: %s: %s\n'%(type(error).__name__,error));sys.exit(3)
print(json.dumps({'frozen':result is not None,'path':result,'entries':count}))
