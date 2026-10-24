import importlib.util, os, stat, subprocess, tempfile, unittest, sys
sys.dont_write_bytecode=True
from pathlib import Path
spec=importlib.util.spec_from_file_location('freeze',Path(__file__).with_name('frozen-source.py')); m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)
def thaw(root):
 for current,dirs,files in os.walk(root,followlinks=False):
  for p in [current]+[os.path.join(current,n) for n in files]:
   if os.path.islink(p):continue
   fd=os.open(p,os.O_RDONLY|os.O_NOFOLLOW)
   try:m.setflags(fd,m.flags(fd)&~m.IMMUTABLE)
   finally:os.close(fd)
class Freeze(unittest.TestCase):
 def fixture(self,root):
  p=Path(root)/'snapshot';p.mkdir();(p/'.git').mkdir();(p/'body').write_text('source');s=p.stat();return p,[s.st_dev,s.st_ino],s.st_uid
 def test_raw_write_and_delete_refused_other_writer_preserved(self):
  with tempfile.TemporaryDirectory() as root:
   p,ident,uid=self.fixture(root); other=Path(root)/'other';other.write_text('other')
   try:
    r=m.freeze(str(p),ident,uid);self.assertTrue(r['ordinaryWritesProtected'])
    with self.assertRaises(PermissionError):(p/'body').write_text('changed')
    with self.assertRaises(PermissionError):(p/'body').unlink()
    with self.assertRaises(PermissionError):p.rename(Path(root)/'renamed')
    other.write_text('still writable');self.assertEqual(other.read_text(),'still writable')
   finally:thaw(str(p))
 def test_reject_hardlinks_external_symlinks_and_shared_git_before_flags(self):
  for kind in ['hardlink','symlink','alternates']:
   with self.subTest(kind=kind),tempfile.TemporaryDirectory() as root:
    p,ident,uid=self.fixture(root);outside=Path(root)/'outside';outside.write_text('preserve')
    if kind=='hardlink':os.link(outside,p/'linked')
    if kind=='symlink':os.symlink(outside,p/'linked')
    if kind=='alternates':(p/'.git/objects/info').mkdir(parents=True);(p/'.git/objects/info/alternates').write_text('/external')
    with self.assertRaises(ValueError):m.freeze(str(p),ident,uid)
    (p/'body').write_text('still mutable');outside.write_text('preserved')
 def test_failed_freeze_restores_only_changed_flags(self):
  with tempfile.TemporaryDirectory() as root:
   p,ident,uid=self.fixture(root);pre=p/'preexisting';pre.write_text('immutable')
   fd=os.open(pre,os.O_RDONLY);m.setflags(fd,m.flags(fd)|m.IMMUTABLE);os.close(fd)
   try:
    def fail(index,path):
     if path==str(p/'body'):raise ValueError('injected partial freeze failure')
    with self.assertRaises(ValueError):m.freeze(str(p),ident,uid,inject=fail)
    (p/'body').write_text('rolled back')
    with self.assertRaises(PermissionError):pre.write_text('changed')
   finally:thaw(str(p))
 def test_concurrent_tree_edit_never_accepted(self):
  with tempfile.TemporaryDirectory() as root:
   p,ident,uid=self.fixture(root)
   def edit(index,path):
    if index==0:(p/'raced').write_text('concurrent')
   with self.assertRaises(ValueError):m.freeze(str(p),ident,uid,inject=edit)
   (p/'body').write_text('mutable after rollback')
if __name__=='__main__':unittest.main()
