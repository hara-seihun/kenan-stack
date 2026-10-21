import { expect,it } from 'vitest';
import {callMeetingBrowser} from './meeting-browser-port.js';
it('preserves own WORK runtime directory and native bus without inheriting credentials',async()=>{
 const uid=process.getuid!(),gid=process.getgid!();
 const code=`process.stdin.resume(); process.stdin.on('end',()=>console.log(JSON.stringify({state:'unknown',observation:{runtime:process.env.XDG_RUNTIME_DIR,bus:process.env.DBUS_SESSION_BUS_ADDRESS,home:process.env.HOME,keys:Object.keys(process.env)}})))`;
 const result=await callMeetingBrowser({executable:process.execPath,args:['-e',code],uid,gid,home:'/tmp'},{action:'inspect',session:'inert'});
 expect(result.observation).toMatchObject({runtime:`/run/user/${uid}`,bus:`unix:path=/run/user/${uid}/bus`,home:'/tmp'});
 expect((result.observation as {keys:string[]}).keys.sort()).toEqual(['DBUS_SESSION_BUS_ADDRESS','HOME','LANG','PATH','XDG_RUNTIME_DIR'].sort());
});
