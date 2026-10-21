import { expect, it } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { ToolBody } from './ToolCall.js';

it('renders upstream envelopes as readable tool-specific content, not JSON',()=>{
 const html=renderToStaticMarkup(createElement(ToolBody,{args:{action:'list'},part:{type:'tool',callId:'test',name:'workers',args:{action:'list'},isError:false,result:JSON.stringify({content:[{type:'text',text:JSON.stringify({items:[{name:'Build UI',state:'running',goalId:'goal-id'}],nextCursor:'cursor'})}],details:{}})}}));
 expect(html).toContain('Build UI');expect(html).toContain('More results available');expect(html).not.toContain('"content"');expect(html).not.toContain('&quot;items&quot;');
});
it('renders errors and edit diffs without dropping their content',()=>{
 const html=renderToStaticMarkup(createElement(ToolBody,{args:{path:'/tmp/test',oldText:'old value',newText:'new value'},part:{type:'tool',callId:'test',name:'edit',args:{path:'/tmp/test',oldText:'old value',newText:'new value'},isError:true,result:JSON.stringify({content:[{type:'text',text:'Edit failed: missing file'}]})}}));
 expect(html).toContain('old value');expect(html).toContain('new value');expect(html).toContain('Edit failed: missing file');expect(html).toContain('class="removed"');
});
