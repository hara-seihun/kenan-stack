import socket,struct,time,re,subprocess,json,select,os,atexit
from pathlib import Path

# The only configuration touched is a temporary loopback-only endpoint.
config=Path("/etc/asterisk/pjsip_local.conf")
if config.exists():
 raise SystemExit("local_endpoint_file_exists: choose another isolated include before running")
Path("/var/tmp/cvs-media-check").mkdir(parents=True,exist_ok=True)
config.write_text("""; Temporary local-only media transfer diagnostic.
[cvs-media-check]
type=aor
contact=sip:cvs-media-check@127.0.0.1:5068
[cvs-media-check]
type=endpoint
transport=kenan-udp
context=default
disallow=all
allow=ulaw
direct_media=no
rtp_symmetric=yes
force_rport=yes
rewrite_contact=yes
aors=cvs-media-check
[cvs-media-check]
type=identify
endpoint=cvs-media-check
match=127.0.0.1
""")
def cleanup():
 channels=subprocess.check_output(["asterisk","-rx","core show channels concise"],text=True)
 for line in channels.splitlines():
  channel=line.split("!")[0]
  if channel.startswith("PJSIP/cvs-media-check-"):
   subprocess.run(["asterisk","-rx","channel request hangup "+channel],stdout=subprocess.DEVNULL)
 config.unlink(missing_ok=True)
 subprocess.run(["asterisk","-rx","pjsip reload"],stdout=subprocess.DEVNULL)
atexit.register(cleanup)
subprocess.run(["asterisk","-rx","pjsip reload"],check=True,stdout=subprocess.DEVNULL)
SIP=('127.0.0.1',5068)
sip=socket.socket(socket.AF_INET,socket.SOCK_DGRAM);sip.bind(SIP);sip.setblocking(False)
media=[]
for p in (28000,28002,28004):
 s=socket.socket(socket.AF_INET,socket.SOCK_DGRAM);s.bind(('127.0.0.1',p));s.setblocking(False);media.append(s)
subprocess.run(['asterisk','-rx','channel originate PJSIP/cvs-media-check application Echo'],check=True)
def msgwait(timeout=5):
 if not select.select([sip],[],[],timeout)[0]:raise RuntimeError('SIP timeout')
 b,a=sip.recvfrom(65535);return b.decode(),a
def headers(m):
 d={}
 for l in m.split('\r\n')[1:]:
  if ': ' in l:
   k,v=l.split(': ',1);d.setdefault(k.lower(),[]).append(v)
 return d
def sdp(port,version):
 return f'v=0\r\no=peer 777 {version} IN IP4 127.0.0.1\r\ns=local-only-media-check\r\nc=IN IP4 127.0.0.1\r\nt=0 0\r\nm=audio {port} RTP/AVP 0\r\na=rtpmap:0 PCMU/8000\r\na=sendrecv\r\na=ptime:20\r\n'
def send(m,a):sip.sendto(m.encode(),a)
invite,addr=msgwait();assert invite.startswith('INVITE'),invite
h=headers(invite);to=h['to'][0]+';tag=cvs-local-test';fr=h['from'][0];cid=h['call-id'][0];target=re.search(r'<([^>]+)>',h['contact'][0]).group(1)
body=sdp(28000,1)
reply='SIP/2.0 200 OK\r\n'+''.join('Via: '+v+'\r\n' for v in h['via'])+f'From: {fr}\r\nTo: {to}\r\nCall-ID: {cid}\r\nCSeq: {h["cseq"][0]}\r\nContact: <sip:cvs-media-check@127.0.0.1:5068>\r\nContent-Type: application/sdp\r\nContent-Length: {len(body)}\r\n\r\n'+body
send(reply,addr)
rtpport=int(re.search(r'm=audio (\d+)',invite).group(1));dest=('127.0.0.1',rtpport)
ack,_=msgwait();assert ack.startswith('ACK'),ack
print(json.dumps({'event':'connected','rtp_dest':dest}),flush=True)
seq=1000;ts=50000;ssrc=111;count=0;cseq=500
results=[]
def phase(name,index,seconds,seq_reset=None,ts_reset=None,ssrc_new=None):
 global seq,ts,ssrc,count
 if seq_reset is not None:seq=seq_reset
 if ts_reset is not None:ts=ts_reset
 if ssrc_new is not None:ssrc=ssrc_new
 # Drain any leftovers from previous phase.
 for s in media:
  while select.select([s],[],[],0)[0]:s.recvfrom(65535)
 begin=time.monotonic();nextsend=begin;n=0;rx=[0]*3;first=[None]*3;last=[None]*3;rtp_info=[]
 while time.monotonic()-begin<seconds:
  now=time.monotonic()
  if now>=nextsend:
   # PCMU silence differs per phase, for distinguishing returned payloads.
   payload=bytes([0xe0+count%16])*160
   packet=struct.pack('!BBHII',0x80,0,seq%65536,ts%2**32,ssrc)+payload
   media[index].sendto(packet,dest);seq+=1;ts+=160;n+=1;nextsend+=.02
  ready,_,_=select.select(media+[sip],[],[],max(0,min(.02,nextsend-time.monotonic())))
  for s in ready:
   data,source=s.recvfrom(65535)
   if s==sip:
    print(json.dumps({'event':'unexpected_sip','text':data.decode(errors='replace')[:300]}),flush=True);continue
   i=media.index(s);rx[i]+=1;dt=round(time.monotonic()-begin,3)
   if first[i] is None:first[i]=dt
   last[i]=dt
   if len(rtp_info)<2:rtp_info.append({'received_on':s.getsockname()[1],'header':struct.unpack('!BBHII',data[:12]),'source':source,'payload':data[12:16].hex()})
 row={'phase':name,'tx_port':media[index].getsockname()[1],'tx_packets':n,'rx_packets':rx,'first_rx_seconds':first,'last_rx_seconds':last,'samples':rtp_info}
 results.append(row);print(json.dumps(row),flush=True);count+=1

def reinvite(port):
 global cseq,dest
 cseq+=1;branch='z9hG4bKlocal'+str(cseq);body=sdp(port,cseq)
 base=f'Via: SIP/2.0/UDP 127.0.0.1:5068;branch={branch}\r\nMax-Forwards: 70\r\nFrom: {to}\r\nTo: {fr}\r\nCall-ID: {cid}\r\n'
 req=f'INVITE {target} SIP/2.0\r\n'+base+f'CSeq: {cseq} INVITE\r\nContact: <sip:cvs-media-check@127.0.0.1:5068>\r\nContent-Type: application/sdp\r\nContent-Length: {len(body)}\r\n\r\n'+body
 send(req,addr)
 while True:
  m,a=msgwait();print(json.dumps({'event':'reinvite_response','status':m.split('\r\n')[0],'port':port}),flush=True)
  if m.startswith('SIP/2.0 1'):continue
  assert m.startswith('SIP/2.0 200'),m
  break
 send(f'ACK {target} SIP/2.0\r\n'+base+f'CSeq: {cseq} ACK\r\nContent-Length: 0\r\n\r\n',addr)
 if re.search(r'm=audio (\d+)',m):dest=('127.0.0.1',int(re.search(r'm=audio (\d+)',m).group(1)))
phase('initial_lock',0,7)
phase('new_port_without_reinvite_still_rejected',1,7,seq_reset=1000,ts_reset=0,ssrc_new=222)
reinvite(28000)
phase('same_sdp_reinvite_actual_port_changed',1,7,seq_reset=1000,ts_reset=0,ssrc_new=333)
cseq+=1
send(f'BYE {target} SIP/2.0\r\nVia: SIP/2.0/UDP 127.0.0.1:5068;branch=z9hG4bKbye\r\nMax-Forwards: 70\r\nFrom: {to}\r\nTo: {fr}\r\nCall-ID: {cid}\r\nCSeq: {cseq} BYE\r\nContent-Length: 0\r\n\r\n',addr)
print(json.dumps({'event':'bye','response':msgwait()[0].split('\r\n')[0]}),flush=True)
json.dump(results,open('/var/tmp/cvs-media-check/results.json','w'),indent=2)
