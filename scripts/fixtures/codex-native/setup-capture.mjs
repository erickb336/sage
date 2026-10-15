// Install and trust only this test observer in a brand-new temporary CODEX_HOME.
import {setupSage} from './setup-sage.mjs';
import {waitNative} from './wait-native.mjs';
import {spawn} from 'node:child_process';
import {readFileSync,writeFileSync,mkdirSync,realpathSync} from 'node:fs';
import {join} from 'node:path';
import assert from 'node:assert/strict';
export async function setupCapture({root,codexHome,workspace,env,binary,denySpawn=false,sage=false,disconnectOnSpawn=false,review=false,nestedReview=false,blockStop=false,captureFailure=false,capacityFailure=false,followupCapacity=false,denyCommand=false,emptyLogbook=false,taskLifecycle=false,omitStop=false,captureCompaction=false,restoreCompaction=false,interruption=false,readTask=false,deadlineMs=120_000}){
 assert(!restoreCompaction||(captureCompaction&&sage), "compaction_restore_needs_sage_capture");
 assert(/^[A-Za-z0-9/._-]+$/.test(realpathSync(root)), "unsafe_probe_root");
 assert.equal(realpathSync(codexHome),join(realpathSync(root),'codex'));
 mkdirSync(join(root,'events'));
 writeFileSync(join(root,'native-identity.mjs'),readFileSync(new URL('../../../packages/sage-codex/runtime/identity.mjs',import.meta.url)));
 writeFileSync(join(root,'recovery-output.mjs'),readFileSync(new URL('../../../packages/sage-codex/runtime/recovery-output.mjs',import.meta.url)));
 const script=join(root,'capture.mjs');
 writeFileSync(script,readFileSync(new URL('./capture-native-hook.mjs',import.meta.url)));
 const command=`node ${JSON.stringify(script)}${denySpawn ? " --deny-spawn" : ""}`;
 // Every caller uses the same hardware-isolated Sage fixture.
 process.env.SAGE_TEST_MACHINE_ID="native-fixture";
 env.SAGE_TEST_MACHINE_ID="native-fixture";
 const integrated=sage?await setupSage(root,{disconnectOnSpawn,review,nestedReview,capacity:followupCapacity||capacityFailure?2:captureFailure||interruption?1:5,capacityFailure,followupCapacity,denyCommand,emptyLogbook,taskLifecycle,omitStop,restoreCompaction,interruption,readTask}):null;
 const baseConfig=integrated?.config??'';
 const blocker=join(root,'block-first-stop.mjs');
 if(blockStop||capacityFailure||followupCapacity)writeFileSync(blocker,readFileSync(new URL('./block-first-stop.mjs',import.meta.url)));
 const compactEvents=captureCompaction?['SessionStart','PreCompact','PostCompact']:[];
 const events=[...compactEvents,'PreToolUse','PostToolUse','SubagentStart','SubagentStop',...(captureFailure?['PostToolUseFailure']:[]),...(sage?['UserPromptSubmit']:[])];
 writeFileSync(join(codexHome,'hooks.json'),JSON.stringify({hooks:Object.fromEntries(events.map(event=>[event,[{hooks:[...(event==='UserPromptSubmit'?[]:[{type:'command',command,timeout:10}]),...((event==='PostToolUseFailure'||(compactEvents.includes(event)&&!(restoreCompaction&&event==='SessionStart')))?[]:integrated?.hook(event)??[]),...((blockStop||capacityFailure||followupCapacity)&&event==='SubagentStop'?[{type:'command',command:`node ${JSON.stringify(blocker)}`,timeout:10}]:[])]}]]))}));
 writeFileSync(join(codexHome,'config.toml'),baseConfig);
 const args=['-c','analytics.enabled=false','-c','otel.exporter="none"','-c','otel.metrics_exporter="none"','-c','otel.trace_exporter="none"','app-server','-c','model_provider="sage_capture_loopback"','-c','model_providers.sage_capture_loopback={name="Isolated hook capture",base_url="http://127.0.0.1:1/v1",wire_api="responses",requires_openai_auth=false}','-c','cli_auth_credentials_store="ephemeral"','-c','features.hooks=true','-c','features.plugins=false','-c','features.apps=false','-c','features.remote_plugin=false'];
 const child=spawn(binary,args,{cwd:workspace,env,stdio:['pipe','pipe','pipe'],shell:false});
 let buf='',failure,verified=false,stderrBytes=0;
 const send=(method,params,id)=>child.stdin.write(JSON.stringify({method,params,...(id?{id}:{})})+'\n');
 let hooks, failureHookAvailable = false;
 const inspect=r=>{
  assert.equal(r.data.length,1);assert.equal(r.data[0].errors.length,0);
  const hs=r.data[0].hooks;
  const failures=hs.filter(h=>h.eventName==='postToolUseFailure');
  assert(failures.length<=1&&(!failures.length||captureFailure));failureHookAvailable=failures.length===1;
  assert.equal(hs.length,(sage?9-(omitStop?1:0):4)+(blockStop||capacityFailure||followupCapacity?1:0)+failures.length+compactEvents.length+(restoreCompaction?2:0));
  assert.deepEqual(hs.map(h=>h.eventName).sort(),[...compactEvents.map(name=>name[0].toLowerCase()+name.slice(1)),...(restoreCompaction?['sessionStart','sessionStart']:[]),'preToolUse','postToolUse','subagentStart','subagentStop',...(sage?['preToolUse','postToolUse',...(omitStop?[]:['subagentStop']),'userPromptSubmit','userPromptSubmit']:[]),...(blockStop||capacityFailure||followupCapacity?['subagentStop']:[]),...(failureHookAvailable?['postToolUseFailure']:[])].sort());

  assert(hs.every(h=>(sage||h.command===command)&&h.enabled&&h.sourcePath===join(codexHome,'hooks.json')));
  return hs;
 };
 child.stdout.on('data',d=>{buf+=d;if(buf.length>2*1024*1024){failure='response_too_large';child.stdin.end();return;}while(buf.includes('\n')){const end=buf.indexOf('\n'),line=buf.slice(0,end);buf=buf.slice(end+1);try{const r=JSON.parse(line);if(![1,2,3].includes(r.id))continue;assert(!r.error,'rpc_error');if(r.id===1){send('initialized',{});send('hooks/list',{cwds:[workspace]},2);}else if(r.id===2){hooks=inspect(r.result);writeFileSync(join(codexHome,'config.toml'),baseConfig+hooks.map(h=>`[hooks.state.${JSON.stringify(h.key)}]\ntrusted_hash=${JSON.stringify(h.currentHash)}\n`).join(''));verified=true;child.stdin.end();}}catch(e){failure=e.message;child.stdin.end();}}});
 child.stderr.on('data',d=>stderrBytes+=d.length);child.stdin.on('error',()=>{});
 send('initialize',{clientInfo:{name:'sage-isolated-capture',version:'0.1.0'},capabilities:{experimentalApi:true}},1);
 const result=await waitNative(child,{deadlineMs});
 assert(verified&&!failure&&result.code===0&&!result.signal,`capture_setup_failed: ${failure??result.reason??'native_exit'}`);
 console.log(JSON.stringify({type:'evidence',event:'isolated_observer_configured',hookCount:hooks.length,onlyTemporaryProfile:true,stderrBytes}));
 return integrated ? { ...integrated, failureHookAvailable } : null;
}
