#!/usr/bin/env python3
"""Install the source-owned read-only runner; does not start or replay intake."""
import os,pathlib,subprocess,tempfile

def install(source,target):
 source=pathlib.Path(source);target=pathlib.Path(target)
 subprocess.run(['python3','-B',str(source.with_name('slack-bounded-intake.test.py'))],check=True,env={**os.environ,'PYTHONDONTWRITEBYTECODE':'1'})
 content=source.read_bytes()
 compile(content,str(source),'exec')
 if target.exists() and target.read_bytes()==content:return False
 target.parent.mkdir(parents=True,exist_ok=True)
 fd,tmp=tempfile.mkstemp(prefix=target.name+'.',dir=target.parent)
 try:
  with os.fdopen(fd,'wb') as out:out.write(content)
  os.chmod(tmp,0o755);os.replace(tmp,target)
 finally:
  if os.path.exists(tmp):os.unlink(tmp)
 return True
if __name__=='__main__':
 print(install(pathlib.Path(__file__).with_name('slack-bounded-intake.py'),'/opt/kenan-acme/deploy/slack-bounded-intake.py'))
