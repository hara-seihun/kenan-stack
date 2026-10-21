import {brotliCompressSync,gzipSync,constants} from 'node:zlib';
import type {Plugin} from 'vite';
export function precompress():Plugin {
 return {name:'owned-static-precompression',apply:'build',enforce:'post',generateBundle(_options,bundle){
  for(const [name,output] of Object.entries(bundle)){
   if(!/\.(?:js|css|html)$/.test(name))continue;
   const bytes=Buffer.from(output.type==='chunk'?output.code:output.source);
   if(bytes.length<256)continue;
   for(const [extension,compressed] of [['br',brotliCompressSync(bytes,{params:{[constants.BROTLI_PARAM_QUALITY]:11}})],['gz',gzipSync(bytes,{level:9})]] as const)
    if(compressed.length<bytes.length)this.emitFile({type:'asset',fileName:name+'.'+extension,source:compressed});
  }
 }};
}
