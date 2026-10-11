// Native patch policy check with fixed simulated responses in a fresh temporary profile.
import assert from 'node:assert/strict';
import http from 'node:http';
import {spawn} from 'node:child_process';
import {mkdtempSync,existsSync,mkdirSync,writeFileSync,readFileSync,readdirSync,rmSync,realpathSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {setupCapture} from './fixtures/codex-native/setup-capture.mjs';
import {waitNative} from './fixtures/codex-native/wait-native.mjs';

assert(process.argv.slice(2).every(arg=>['--protected-target','--chief'].includes(arg))&&new Set(process.argv.slice(2)).size===process.argv.length-2,'unknown_probe_arguments');
const chief=process.argv.includes('--chief');
const protectedTarget=process.argv.includes('--protected-target');
const denied=protectedTarget||chief;
const root=realpathSync(mkdtempSync(join(tmpdir(),'sage-patch-boundary-')));
let server;
try {
 const workspace=join(root,'workspace'),codexHome=join(root,'codex');
 for(const name of ['workspace','codex','home','tmp'])mkdirSync(join(root,name));
 const target=protectedTarget?join(root,'logbook/forbidden.txt'):'ordinary.txt';
 const patch=`*** Begin Patch\n*** Add File: ${target}\n+fixed native patch\n*** End Patch`;
 const env={PATH:process.env.PATH??'/usr/bin:/bin',HOME:join(root,'home'),CODEX_HOME:codexHome,TMPDIR:join(root,'tmp'),LANG:'en_US.UTF-8',DO_NOT_TRACK:'1'};
 const binary=process.env.SAGE_CODEX_BIN??'codex';
 const telemetry=['-c','analytics.enabled=false','-c','otel.exporter="none"','-c','otel.metrics_exporter="none"','-c','otel.trace_exporter="none"'];
 const launch=args=>spawn(binary,[...telemetry,...args],{cwd:workspace,env,shell:false,stdio:['pipe','pipe','pipe']});
 const version=launch(['--version']);let versionText='';
 version.stdout.on('data',d=>versionText+=d);version.stderr.resume();version.stdin.end();
 assert.equal((await waitNative(version)).code,0);
 assert.equal(versionText.trim(),'codex-cli 0.160.0','unverified_native_version');
 const integrated=await setupCapture({root,codexHome,workspace,env,binary,sage:true});
 const catalog=join(root,'models.json');
 writeFileSync(catalog,JSON.stringify({models:[{slug:'sage-patch-fixture',display_name:'Sage patch fixture',supported_reasoning_levels:[],shell_type:'disabled',apply_patch_tool_type:'freeform',visibility:'list',supported_in_api:true,priority:1,support_verbosity:false,truncation_policy:{mode:'bytes',limit:10000},experimental_supported_tools:[],tool_mode:'direct',model_messages:{instructions_template:'Apply only the fixed fixture patch.'}}]}));
 let requests=0,fixtureError,toolSchema,commandResult;
 const pending=new Set();
 server=http.createServer(async(req,res)=>{
  pending.add(res);res.once('finish',()=>pending.delete(res));
  try {
   assert.equal(req.method,'POST');assert.equal(req.url,'/v1/responses');
   let body='';for await(const chunk of req){body+=chunk;assert(body.length<2*1024*1024);}
   const request=JSON.parse(body);requests++;let item;
   if(requests===1){
    const candidates=(request.tools??[]).flatMap(t=>t.type==='namespace'?(t.tools??[]).filter(m=>m.name==='apply_patch').map(m=>({namespace:t.name,...m})):t.name==='apply_patch'?[t]:[]);
    assert.equal(candidates.length,1,'apply_patch_schema_missing');
    const tool=candidates[0];toolSchema={namespace:tool.namespace??null,name:tool.name,properties:Object.keys(tool.parameters?.properties??{}),required:tool.parameters?.required??[]};
    assert.equal(tool.type,'custom');
    item={type:'custom_tool_call',...(tool.namespace?{namespace:tool.namespace}:{}),name:tool.name,call_id:'fixed_patch',input:patch};
   }else{
    assert.equal(requests,2,'unexpected_extra_request');
    const outputs=request.input.filter(i=>['custom_tool_call_output','function_call_output'].includes(i.type)&&i.call_id==='fixed_patch');assert.equal(outputs.length,1);
    commandResult=outputs[0].output;if(denied)assert(JSON.stringify(commandResult).includes(chief?'chief must give':'protected path'),'patch_denial_missing');
    item={id:'fixed_final',type:'message',role:'assistant',status:'completed',content:[{type:'output_text',text:'patch boundary checked',annotations:[]}]};
   }
   const id=`command_probe_${requests}`;
   res.writeHead(200,{'Content-Type':'text/event-stream',Connection:'close'});
   for(const event of [{type:'response.created',response:{id,status:'in_progress',output:[]}},{type:'response.output_item.done',output_index:0,item},{type:'response.completed',response:{id,status:'completed',output:[item],usage:{input_tokens:0,output_tokens:0,total_tokens:0}}}])res.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
   res.end();
  }catch(error){fixtureError=error.message;res.writeHead(400,{'Content-Type':'application/json'});res.end(JSON.stringify({error:{message:'Fixed fixture failed'}}));}
 });
 await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve);});
 const config={model_provider:'sage_patch_fixture',model:'sage-patch-fixture',model_catalog_json:catalog,cli_auth_credentials_store:'ephemeral','features.hooks':true,'features.plugins':false,'features.remote_plugin':false,'features.apps':false,'features.shell_snapshot':false,'features.shell_tool':false,'features.enable_request_compression':false,allow_login_shell:false};
 const args=['exec','--strict-config','--skip-git-repo-check','-C',workspace,'-s','workspace-write','--json'];
 for(const [key,value]of Object.entries(config))args.push('-c',`${key}=${JSON.stringify(value)}`);
 args.push('-c',`model_providers.sage_patch_fixture={name="Fixed patch fixture",base_url="http://127.0.0.1:${server.address().port}/v1",wire_api="responses",requires_openai_auth=false,supports_websockets=false}`,'-');
 const child=launch(args);let stdout='',stderrBytes=0;
 child.stdout.on('data',d=>{stdout+=d;});child.stderr.on('data',d=>stderrBytes+=d.length);child.stdin.on('error',()=>{});child.stdin.end(chief?'sage mode\n':'sage mode off\n');
 const result=await waitNative(child,{onTimeout:()=>{server.closeAllConnections();}});
 server.closeAllConnections();await new Promise(resolve=>server.close(resolve));server=null;
 const events=readdirSync(join(root,'events')).map(n=>JSON.parse(readFileSync(join(root,'events',n),'utf8')));
 console.log(JSON.stringify({type:'patch_boundary',version:versionText.trim(),toolSchema,
  callbacks:events.map(({hook_event_name,tool_name,toolInputShape})=>({hook_event_name,tool_name,toolInputShape})),
  result,requests,fixtureError,stderrBytes,protectedTarget,chief,simulatedModel:true}));
 assert.equal(result.code,0);assert.equal(fixtureError,undefined);assert.equal(requests,2);
 const before=events.filter(e=>e.hook_event_name==='PreToolUse');assert.equal(before.length,1);
 assert.equal(before[0].tool_name,'apply_patch');assert.deepEqual(before[0].toolInputShape,{command:'string'});
 assert.equal(events.filter(e=>e.hook_event_name==='PostToolUse').length,denied?0:1);
 assert.equal(integrated.readJournal().modes.at(-1)?.sage===true,chief,'fixture_mode_mismatch');
 const receipt=JSON.parse(readFileSync(join(root,'patch-policy-receipt.json'),'utf8'));
 assert.equal(receipt.session,before[0].session_id);assert.equal(receipt.turn,before[0].turn_id);assert.equal(receipt.call,before[0].tool_use_id);
 assert.equal(receipt.result.decision,denied?'deny':'pass');
 const items=stdout.trim().split('\n').map(line=>JSON.parse(line));
 const changes=items.filter(event=>event.type==='item.completed'&&event.item?.type==='file_change');
 if(denied){assert.equal(changes.length,0);assert.equal(existsSync(protectedTarget?target:join(workspace,target)),false);}
 else{assert.equal(changes.length,1);assert.equal(readFileSync(join(workspace,target),'utf8'),'fixed native patch\n');}
 assert(stdout.includes('patch boundary checked'));
 console.log(JSON.stringify({type:'result',verified:true,protectedTarget,chief,actualFileVerified:true,simulatedModel:true,installedSageVerified:false}));
}finally{
 server?.closeAllConnections();server?.close();rmSync(root,{recursive:true,force:true});
}
