// Native command-hook boundary evidence with fixed simulated responses, not an installed Sage pilot.
import assert from 'node:assert/strict';
import http from 'node:http';
import {spawn} from 'node:child_process';
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,readdirSync,rmSync,realpathSync,existsSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {setupCapture} from './fixtures/codex-native/setup-capture.mjs';
import {waitNative} from './fixtures/codex-native/wait-native.mjs';

assert(process.argv.slice(2).every(arg=>['--deny-command','--default-command','--sage-off','--extended-command'].includes(arg))&&new Set(process.argv.slice(2)).size===process.argv.length-2,'unknown_probe_arguments');
const extendedCommand=process.argv.includes('--extended-command');
const sageOff=process.argv.includes('--sage-off');
const defaultCommand=process.argv.includes('--default-command');
const denyCommand=process.argv.includes('--deny-command');
assert(!(extendedCommand&&defaultCommand),'extended_command_requires_explicit_context');
const root=realpathSync(mkdtempSync(join(tmpdir(),'sage-command-boundary-')));
const command='printf sage-native-command-ok; pwd', marker='sage-native-command-ok';
let server;
try {
 const workspace=join(root,'workspace'),codexHome=join(root,'codex');
 for(const name of ['workspace','codex','home','tmp'])mkdirSync(join(root,name));
 const commandDirectory=join(workspace,'command-workdir');mkdirSync(commandDirectory);
 const commandArgs=defaultCommand?{cmd:command,max_output_tokens:1000}:{cmd:command,shell:'/bin/sh',workdir:commandDirectory,tty:false,max_output_tokens:1000};
 if(extendedCommand)Object.assign(commandArgs,{login:false,timeout_ms:60000,sandbox_permissions:'use_default',additional_permissions:null,justification:null,prefix_rule:null,environment_id:null});
 const env={PATH:process.env.PATH??'/usr/bin:/bin',HOME:join(root,'home'),CODEX_HOME:codexHome,TMPDIR:join(root,'tmp'),LANG:'en_US.UTF-8',DO_NOT_TRACK:'1'};
 const binary=process.env.SAGE_CODEX_BIN??'codex';
 const telemetry=['-c','analytics.enabled=false','-c','otel.exporter="none"','-c','otel.metrics_exporter="none"','-c','otel.trace_exporter="none"'];
 const launch=args=>spawn(binary,[...telemetry,...args],{cwd:workspace,env,shell:false,stdio:['pipe','pipe','pipe']});
 const version=launch(['--version']);let versionText='';
 version.stdout.on('data',d=>versionText+=d);version.stderr.resume();version.stdin.end();
 assert.equal((await waitNative(version)).code,0);
 assert.equal(versionText.trim(),'codex-cli 0.160.0','unverified_native_version');
 const integrated=await setupCapture({root,codexHome,workspace,env,binary,completion:true,commandProbe:true,denyCommand});
 const catalog=join(root,'models.json');
 writeFileSync(catalog,JSON.stringify({models:[{slug:'sage-command-fixture',display_name:'Sage command fixture',supported_reasoning_levels:[],shell_type:'unified_exec',visibility:'list',supported_in_api:true,priority:1,support_verbosity:false,truncation_policy:{mode:'bytes',limit:10000},experimental_supported_tools:[],tool_mode:'direct',model_messages:{instructions_template:'Run only the fixed harmless fixture command.'}}]}));
 let requests=0,fixtureError,toolSchema,commandResult;
 const pending=new Set();
 server=http.createServer(async(req,res)=>{
  pending.add(res);res.once('finish',()=>pending.delete(res));
  try {
   assert.equal(req.method,'POST');assert.equal(req.url,'/v1/responses');
   let body='';for await(const chunk of req){body+=chunk;assert(body.length<2*1024*1024);}
   const request=JSON.parse(body);requests++;let item;
   if(requests===1){
    const candidates=(request.tools??[]).flatMap(t=>t.type==='namespace'?(t.tools??[]).filter(m=>m.name==='exec_command').map(m=>({namespace:t.name,...m})):t.name==='exec_command'?[t]:[]);
    assert.equal(candidates.length,1,'exec_command_schema_missing');
    const tool=candidates[0];toolSchema={namespace:tool.namespace??null,name:tool.name,properties:Object.keys(tool.parameters?.properties??{}),required:tool.parameters?.required??[]};
    item={type:'function_call',...(tool.namespace?{namespace:tool.namespace}:{}),name:tool.name,call_id:'fixed_command',arguments:JSON.stringify(commandArgs)};
   }else{
    assert.equal(requests,2,'unexpected_extra_request');
    const outputs=request.input.filter(i=>i.type==='function_call_output'&&i.call_id==='fixed_command');assert.equal(outputs.length,1);
    commandResult=outputs[0].output;assert(JSON.stringify(commandResult).includes(denyCommand?'sage-fixed-command-denial':marker),'fixed_command_output_missing');
    item={id:'fixed_final',type:'message',role:'assistant',status:'completed',content:[{type:'output_text',text:'command boundary checked',annotations:[]}]};
   }
   const id=`command_probe_${requests}`;
   res.writeHead(200,{'Content-Type':'text/event-stream',Connection:'close'});
   for(const event of [{type:'response.created',response:{id,status:'in_progress',output:[]}},{type:'response.output_item.done',output_index:0,item},{type:'response.completed',response:{id,status:'completed',output:[item],usage:{input_tokens:0,output_tokens:0,total_tokens:0}}}])res.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
   res.end();
  }catch(error){fixtureError=error.message;res.writeHead(400,{'Content-Type':'application/json'});res.end(JSON.stringify({error:{message:'Fixed fixture failed'}}));}
 });
 await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve);});
 const config={model_provider:'sage_command_fixture',model:'sage-command-fixture',model_catalog_json:catalog,cli_auth_credentials_store:'ephemeral','features.hooks':true,'features.plugins':false,'features.remote_plugin':false,'features.apps':false,'features.shell_snapshot':false,'features.shell_tool':true,'features.enable_request_compression':false,allow_login_shell:false};
 const args=['exec','--strict-config','--skip-git-repo-check','-C',workspace,'-s','read-only','--json'];
 for(const [key,value]of Object.entries(config))args.push('-c',`${key}=${JSON.stringify(value)}`);
 args.push('-c',`model_providers.sage_command_fixture={name="Fixed command fixture",base_url="http://127.0.0.1:${server.address().port}/v1",wire_api="responses",requires_openai_auth=false,supports_websockets=false}`,'-');
 const child=launch(args);let stdout='',stderrBytes=0;
 child.stdout.on('data',d=>{stdout+=d;});child.stderr.on('data',d=>stderrBytes+=d.length);child.stdin.on('error',()=>{});child.stdin.end(sageOff?'sage mode off\n':'sage mode\n');
 const result=await waitNative(child,{onTimeout:()=>{server.closeAllConnections();}});
 server.closeAllConnections();await new Promise(resolve=>server.close(resolve));server=null;
 const events=readdirSync(join(root,'events')).map(n=>JSON.parse(readFileSync(join(root,'events',n),'utf8')));
 console.log(JSON.stringify({type:'command_boundary',version:versionText.trim(),toolSchema,callbacks:events.map(({hook_event_name,tool_name,toolInputShape,fixedCommandMatched,responseShape,commandTranscript,commandHookFields,hookCwdIsWorkspace,hookCwdIsCommandDirectory,turnContextFields,turnCwdIsWorkspace})=>({hook_event_name,tool_name,toolInputShape,fixedCommandMatched,responseShape,commandTranscript,commandHookFields,hookCwdIsWorkspace,hookCwdIsCommandDirectory,turnContextFields,turnCwdIsWorkspace})),result,requests,fixtureError,stderrBytes,simulatedModel:true,fullPolicyVerified:false}));
 assert.equal(result.code,0);assert.equal(fixtureError,undefined);assert.equal(requests,2);
 assert.equal(events.filter(e=>e.hook_event_name==='PreToolUse'&&e.fixedCommandMatched).length,1);
 assert.equal(events.filter(e=>e.hook_event_name==='PostToolUse'&&e.fixedCommandMatched).length,denyCommand?0:1);
 assert.equal(integrated.readJournal().modes.at(-1)?.sage,!sageOff,'requested_sage_mode_required');
 for(const event of events){assert.equal(event.tool_name,'Bash');assert.deepEqual(event.toolInputShape,{command:'string'});}
 const before=events.find(event=>event.hook_event_name==='PreToolUse');
 const completed=stdout.trim().split('\n').map(line=>JSON.parse(line)).filter(event=>event.type==='item.completed'&&event.item?.type==='command_execution');
 if(denyCommand)assert.equal(completed.length,0,'denied_command_must_not_execute');
 else{
  assert.equal(completed.length,1,'one_native_command_execution');
  assert.equal(completed[0].item.exit_code,0,'native_command_failed');
  assert.equal(completed[0].item.aggregated_output,marker+(defaultCommand?workspace:commandDirectory)+'\n','native_command_output_mismatch');
 }
 const receipt=JSON.parse(readFileSync(join(root,'command-policy-receipt.json'),'utf8'));
 assert.equal(receipt.session,before.session_id);assert.equal(receipt.turn,before.turn_id);assert.equal(receipt.call,before.tool_use_id);
 assert.deepEqual(receipt.command,commandArgs);
 assert.equal(receipt.sage,!sageOff);
 assert.equal(receipt.result.decision,denyCommand?'deny':'pass');
 assert(stdout.includes('command boundary checked'));
 console.log(JSON.stringify({type:'result',verified:true,simulatedModel:true,policyReceivedOriginalFields:true,deniedCommand:denyCommand,defaultCommand,extendedCommand,sageMode:!sageOff,executionShell:completed[0]?.item.command?.match(/^([^ ]+)/)?.[1],effectiveDirectoryVerified:!denyCommand,installedSageVerified:false}));
}finally{
 server?.closeAllConnections();server?.close();rmSync(root,{recursive:true,force:true});
 assert.equal(existsSync(root),false);console.log(JSON.stringify({type:"cleanup",temporaryRootRemoved:true}));
}
