// Native patch policy check with fixed simulated responses in a fresh temporary profile.
import assert from 'node:assert/strict';
import http from 'node:http';
import {spawn} from 'node:child_process';
import {mkdtempSync,existsSync,mkdirSync,writeFileSync,readFileSync,readdirSync,rmSync,realpathSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {setupCapture} from './fixtures/codex-native/setup-capture.mjs';
import {resolveRestartBinary} from './fixtures/codex-native/restart-binary.mjs';
import {trackOwnerProcess} from './fixtures/codex-native/owner-turns.mjs';
import {cleanupRestart} from './fixtures/codex-native/restart-cleanup.mjs';
import {assertPatchEvidence} from './fixtures/codex-native/patch-evidence.mjs';

assert(process.argv.slice(2).every(arg=>['--protected-target','--chief'].includes(arg))&&new Set(process.argv.slice(2)).size===process.argv.length-2,'unknown_probe_arguments');
const chief=process.argv.includes('--chief');
const protectedTarget=process.argv.includes('--protected-target');
assert(!(protectedTarget && chief), "separate_trials_required");
const denied=protectedTarget||chief;
const root=realpathSync(mkdtempSync(join(tmpdir(),'sage-patch-boundary-')));
let server, failure, verified=false;
const handles=[], pending=new Set();
try {
 const workspace=join(root,'workspace'),codexHome=join(root,'codex');
 for(const name of ['workspace','codex','home','tmp'])mkdirSync(join(root,name));
 const target=protectedTarget?join(root,'logbook/forbidden.txt'):'ordinary.txt';
 const patch=`*** Begin Patch\n*** Add File: ${target}\n+fixed native patch\n*** End Patch`;
 const env={PATH:process.env.PATH??'/usr/bin:/bin',HOME:join(root,'home'),CODEX_HOME:codexHome,TMPDIR:join(root,'tmp'),LANG:'en_US.UTF-8',DO_NOT_TRACK:'1',SAGE_TEST_MACHINE_ID:'native-fixture'};
 const {file:binary}=resolveRestartBinary({override:process.env.SAGE_CODEX_BIN});
 const telemetry=['-c','analytics.enabled=false','-c','otel.exporter="none"','-c','otel.metrics_exporter="none"','-c','otel.trace_exporter="none"'];
 const launch=args=>{
  const child=spawn(binary,[...telemetry,...args],{cwd:workspace,env,shell:false,stdio:['pipe','pipe','pipe']});
  const handle=trackOwnerProcess(child,{onTimeout:()=>{for(const response of pending)response.destroy();server?.closeAllConnections();}});
  handles.push(handle);return handle;
 };
 const versionHandle=launch(['--version']),version=versionHandle.child;let versionText='',versionLarge=false;
 version.stdout.on('data',d=>{if(Buffer.byteLength(versionText)+d.length>4096)versionLarge=true;else versionText+=d;});version.stderr.resume();version.stdin.end();
 assert.equal((await versionHandle.stopped).code,0);
 assert(!versionLarge,'version_output_too_large');
 assert.equal(versionText.trim(),'codex-cli 0.160.0','unverified_native_version');
 const integrated=await setupCapture({root,codexHome,workspace,env,binary,completion:true,recovery:true,patchProbe:true,captureSessionStart:true});
 const catalog=join(root,'models.json');
 writeFileSync(catalog,JSON.stringify({models:[{slug:'sage-patch-fixture',display_name:'Sage patch fixture',supported_reasoning_levels:[],shell_type:'disabled',apply_patch_tool_type:'freeform',visibility:'list',supported_in_api:true,priority:1,support_verbosity:false,truncation_policy:{mode:'bytes',limit:10000},experimental_supported_tools:[],tool_mode:'direct',model_messages:{instructions_template:'Apply only the fixed fixture patch.'}}]}));
 let requests=0,fixtureError,toolSchema,commandResult;
 const initialLogbook=integrated.readLogbook();
 server=http.createServer(async(req,res)=>{
  pending.add(res);res.once('close',()=>pending.delete(res));
  try {
   assert.equal(req.method,'POST');assert.equal(req.url,'/v1/responses');
   let body='';for await(const chunk of req){assert(Buffer.byteLength(body)+chunk.length<=2*1024*1024,'request_too_large');body+=chunk;}
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
    commandResult=outputs[0].output;writeFileSync(join(root,'actual-tool-result.json'),JSON.stringify(outputs[0]));if(denied)assert(JSON.stringify(commandResult).includes(chief?'This Sage role cannot edit files':'protected path'),'patch_denial_missing');
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
 const nativeHandle=launch(args),child=nativeHandle.child;let stdout='',stderrBytes=0,outputLarge=false;
 child.stdout.on('data',d=>{if(Buffer.byteLength(stdout)+d.length>2*1024*1024)outputLarge=true;else if(!outputLarge)stdout+=d;});child.stderr.on('data',d=>stderrBytes+=d.length);child.stdin.on('error',()=>{});child.stdin.end(chief?'sage mode\n':'sage mode off\n');
 const result=await nativeHandle.stopped;
 writeFileSync(join(root,'native-output.jsonl'),stdout);
 assert(!outputLarge,'native_output_too_large');
 server.closeAllConnections();await new Promise(resolve=>server.close(resolve));server=null;
 const names=readdirSync(join(root,'events'));assert(names.length<=64,'too_many_hook_events');
 const events=names.map(n=>{const text=readFileSync(join(root,'events',n),'utf8');assert(Buffer.byteLength(text)<=65536,'hook_event_too_large');return JSON.parse(text);});
 assert.equal(result.code,0);assert.equal(fixtureError,undefined);assert.equal(requests,2);
 const items=stdout.trim().split('\n').map(line=>JSON.parse(line));
 const receiptFile=join(root,'patch-policy-receipt.json');
 const receipt=existsSync(receiptFile)?JSON.parse(readFileSync(receiptFile,'utf8')):null;
 const file=protectedTarget?target:join(workspace,target);
 const fileContents=existsSync(file)?readFileSync(file,'utf8'):null;
 assertPatchEvidence({chief,protectedTarget,commandResult,events,items,receipt,fileContents});
 assert.equal(integrated.readJournal().modes.at(-1)?.sage===true,chief,'fixture_mode_mismatch');
 assert.equal(integrated.readJournal().reservations.length,0);
 assert.deepEqual(integrated.readLogbook(),initialLogbook);
 verified=true;
 console.log(JSON.stringify({type:'result',verified:true,version:versionText.trim(),toolSchema,
  protectedTarget,chief,requests,actualFileVerified:true,policyReceipt:receipt?.result.decision??null,
  evaluatorReached:receipt!==null,actualToolResultVerified:true,hookIdentityVerified:true,
  localFixedCwdAndProtectedRoot:true,logbookUnchanged:true,stderrBytes,
  simulatedModel:true,installedSageVerified:false}));
} catch(error) {
 failure=error;
} finally {
 const cleanup=await cleanupRestart({handles,
  capture:()=>{
   if(failure)writeFileSync(join(root,'failure.txt'),String(failure.stack??failure));
   writeFileSync(join(root,'patch-evidence.json'),JSON.stringify({verified,chief,protectedTarget,simulatedModel:true}));
   return {complete:true,verified};
  },
  closeResponses:()=>{for(const response of pending)response.destroy();},
  closeServer:()=>new Promise((resolve,reject)=>{
   if(!server?.listening)return resolve();
   server.closeAllConnections();server.close(error=>error?reject(error):resolve());
  }),
  removeRoot:()=>{if(!verified)throw Error('probe_failed_preserve_evidence');rmSync(root,{recursive:true,force:true});assert(!existsSync(root));}
 });
 console.log(JSON.stringify({type:'cleanup',complete:cleanup.complete,ownedHandlesClosed:cleanup.ownedHandlesClosed,
  temporaryRootRemoved:!existsSync(root),errorPhases:cleanup.errors.map(row=>row.phase)}));
 if(failure||!cleanup.complete){console.error(JSON.stringify({type:'failure',code:'patch_probe_failed',evidencePreserved:existsSync(root)}));process.exitCode=1;}
}
