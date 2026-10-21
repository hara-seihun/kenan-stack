import { useEffect, useRef, useState } from 'react';
import { Paperclip, File, Image, Camera } from 'lucide-react';
import { useOverlay } from './overlay.js';
export function Attachments({uploading,upload}: {uploading:boolean;upload:(files:FileList|null)=>Promise<void>}) {
  const [open,setOpen]=useState(false), root=useRef<HTMLDivElement>(null), button=useRef<HTMLButtonElement>(null);
  const files=useRef<HTMLInputElement>(null), images=useRef<HTMLInputElement>(null), camera=useRef<HTMLInputElement>(null);
  useEffect(()=>{if(!open)return;const outside=(event:PointerEvent)=>{if(!root.current?.contains(event.target as Node))setOpen(false);};document.addEventListener('pointerdown',outside);root.current?.querySelector<HTMLButtonElement>('[role=menuitem]')?.focus();return()=>document.removeEventListener('pointerdown',outside);},[open]);
  useOverlay(open,()=>{setOpen(false);button.current?.focus();});
  const choose=(input:HTMLInputElement|null)=>{setOpen(false);button.current?.focus();input?.click();};
  return <div className="attachment-menu" ref={root} onKeyDown={event=>{if(['ArrowDown','ArrowUp','Home','End'].includes(event.key)&&open){event.preventDefault();const items=Array.from(root.current!.querySelectorAll<HTMLButtonElement>('[role=menuitem]'));const i=items.indexOf(document.activeElement as HTMLButtonElement);items[event.key==='Home'?0:event.key==='End'?items.length-1:(i+(event.key==='ArrowDown'?1:items.length-1))%items.length]?.focus();}}}>
    <button type="button" className="attach" aria-label="Attach" aria-haspopup="menu" aria-expanded={open} disabled={uploading} ref={button} onClick={()=>setOpen(!open)}><Paperclip size={17}/>{uploading?'Uploading…':'Attach'}</button>
    {open&&<div role="menu" aria-label="Attachment choices"><button role="menuitem" type="button" onClick={()=>choose(files.current)}><File size={17}/>Files</button><button role="menuitem" type="button" onClick={()=>choose(images.current)}><Image size={17}/>Images</button><button role="menuitem" type="button" onClick={()=>choose(camera.current)}><Camera size={17}/>Camera</button></div>}
    <input hidden ref={files} type="file" multiple aria-label="Choose files" onChange={e=>{void upload(e.target.files);e.target.value='';}}/>
    <input hidden ref={images} type="file" multiple accept="image/*" aria-label="Choose images" onChange={e=>{void upload(e.target.files);e.target.value='';}}/>
    <input hidden ref={camera} type="file" accept="image/*" capture="environment" aria-label="Take a photo" onChange={e=>{void upload(e.target.files);e.target.value='';}}/>
  </div>;
}
