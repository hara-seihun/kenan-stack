#!/usr/bin/python3
"""Bounded read-only immutable-bit observation; never changes flags or follows links."""
import array,errno,fcntl,json,os,stat,sys,time
request={'path':sys.argv[1],'recursive':sys.argv[2]=='recursive'};deadline=time.monotonic()+5;count=0

def visit(p):
 global count
 count+=1
 if count>200000 or time.monotonic()>deadline:raise RuntimeError('immutable observation budget exhausted')
 st=os.lstat(p)
 if stat.S_ISLNK(st.st_mode):return None
 if not(stat.S_ISDIR(st.st_mode) or stat.S_ISREG(st.st_mode)):return None
 fd=os.open(p,os.O_RDONLY|os.O_NOFOLLOW|os.O_NONBLOCK)
 try:
  current=os.fstat(fd)
  if (current.st_dev,current.st_ino)!=(st.st_dev,st.st_ino):raise RuntimeError('inode changed')
  flags=array.array('L',[0])
  try:fcntl.ioctl(fd,0x80086601,flags,True)
  except OSError as error:
   if error.errno not in (errno.ENOTTY,errno.EOPNOTSUPP):raise
  if flags[0]&0x10:return p
 finally:os.close(fd)
 if request.get('recursive') and stat.S_ISDIR(st.st_mode):
  with os.scandir(p) as entries:
   for entry in entries:
    result=visit(entry.path)
    if result:return result
 return None
result=visit(request['path']);print(json.dumps({'frozen':result is not None,'path':result,'entries':count}))
