// Install and trust only this test observer in a brand-new temporary CODEX_HOME.
import {waitNative} from './wait-native.mjs';
import {spawn} from 'node:child_process';
import {readFileSync,writeFileSync,mkdirSync,realpathSync,cpSync} from 'node:fs';
import {pathToFileURL} from 'node:url';
import {join} from 'node:path';
import assert from 'node:assert/strict';
export async function setupCompaction({root,codexHome,workspace,env,binary,deadlineMs=120_000}){
 assert(/^[A-Za-z0-9/._-]+$/.test(realpathSync(root)), "unsafe_probe_root");
 assert.equal(realpathSync(codexHome),join(realpathSync(root),'codex'));
 mkdirSync(join(root,'events'));
 cpSync(new URL('../../../plugins/sage-codex',import.meta.url),join(root,'plugin'),{recursive:true});
 const {configureAdmission,readAdmission,createStateTool}=await import(pathToFileURL(join(root,'plugin/core/index.mjs')));
 const mode={directory:join(root,'admission'),project:'native-fixture',projectDirectory:workspace,sessionsDir:join(codexHome,'sessions')};
 configureAdmission(mode.directory,{total:5,projects:[{project:mode.project,limit:5}]});
 const tool=createStateTool({defaultRoot:()=>{throw Error('No ambient logbook');}});
 const stateEnv={...env,SAGE_HOME:join(root,'logbook')};
 const command=(...args)=>tool.sage([...args,'--project',workspace],stateEnv);
 command('init');command('task','add', '--priority', 'P2','--title','Native compaction fixture','--size','small');
 command('run','add','T1','--role','lead');
 const logbook=tool.storeDir(workspace,stateEnv);
 const readLogbook=()=>Object.fromEntries(['tasks','runs','ledger','findings','gates','decisions'].map(name=>[name,tool.read(logbook,name)]));
 writeFileSync(join(root,'compaction-mode.json'),JSON.stringify(mode));
 writeFileSync(join(root,'compaction-hook-server.mjs'),readFileSync(new URL('./compaction-hook-server.mjs',import.meta.url)));
 const baseConfig=`[mcp_servers.sage_fixture]\nrequired=true\ncommand=${JSON.stringify(process.execPath)}\nargs=[${JSON.stringify(join(root,'compaction-hook-server.mjs'))}]\n`;
 const script=join(root,'capture.mjs');
 writeFileSync(script,readFileSync(new URL('./capture-compaction.mjs',import.meta.url)));
 const captureCommand=`node ${JSON.stringify(script)}`;
 const events=['SessionStart','PreCompact','PostCompact','UserPromptSubmit'];
 const hooksFor=event=>{
   const hooks=event==='UserPromptSubmit'?[]:[{type:'command',command:captureCommand,timeout:10}];
   if(event==='SessionStart'||event==='UserPromptSubmit'){
     const fields=['cwd','hook_event_name','model','permission_mode','session_id','transcript_path',...(event==='SessionStart'?['source']:['prompt','turn_id'])];
     for(const part of [0,1]) hooks.push({type:'mcp_tool',server:'sage_fixture',tool:'sage_native_hook',timeout:10,
       input:{...Object.fromEntries(fields.map(key=>[key,'${'+key+'}'])),instruction_part:part}});
   }
   return hooks;
 };
 writeFileSync(join(codexHome,'hooks.json'),JSON.stringify({hooks:Object.fromEntries(events.map(event=>[event,[{hooks:hooksFor(event)}]]))}));
 writeFileSync(join(codexHome,'config.toml'),baseConfig);
 const args=['-c','analytics.enabled=false','-c','otel.exporter="none"','-c','otel.metrics_exporter="none"','-c','otel.trace_exporter="none"','app-server','-c','model_provider="sage_capture_loopback"','-c','model_providers.sage_capture_loopback={name="Isolated hook capture",base_url="http://127.0.0.1:1/v1",wire_api="responses",requires_openai_auth=false}','-c','cli_auth_credentials_store="ephemeral"','-c','features.hooks=true','-c','features.plugins=false','-c','features.apps=false','-c','features.remote_plugin=false'];
 const child=spawn(binary,args,{cwd:workspace,env,stdio:['pipe','pipe','pipe'],shell:false});
 let buf='',failure,verified=false,stderrBytes=0;
 const send=(method,params,id)=>child.stdin.write(JSON.stringify({method,params,...(id?{id}:{})})+'\n');
 let hooks;
 const inspect=r=>{
  assert.equal(r.data.length,1);assert.equal(r.data[0].errors.length,0);
  const hs=r.data[0].hooks;assert.equal(hs.length,7);
  assert.deepEqual(hs.map(h=>h.eventName).sort(),['sessionStart','sessionStart','sessionStart','preCompact','postCompact','userPromptSubmit','userPromptSubmit'].sort());

  assert(hs.every(h=>h.enabled&&h.sourcePath===join(codexHome,'hooks.json')));
  return hs;
 };
 child.stdout.on('data',d=>{buf+=d;if(buf.length>2*1024*1024){failure='response_too_large';child.stdin.end();return;}while(buf.includes('\n')){const end=buf.indexOf('\n'),line=buf.slice(0,end);buf=buf.slice(end+1);try{const r=JSON.parse(line);if(![1,2,3].includes(r.id))continue;assert(!r.error,'rpc_error');if(r.id===1){send('initialized',{});send('hooks/list',{cwds:[workspace]},2);}else if(r.id===2){hooks=inspect(r.result);writeFileSync(join(codexHome,'config.toml'),baseConfig+hooks.map(h=>`[hooks.state.${JSON.stringify(h.key)}]\ntrusted_hash=${JSON.stringify(h.currentHash)}\n`).join(''));verified=true;child.stdin.end();}}catch(e){failure=e.message;child.stdin.end();}}});
 child.stderr.on('data',d=>stderrBytes+=d.length);child.stdin.on('error',()=>{});
 send('initialize',{clientInfo:{name:'sage-isolated-capture',version:'0.1.0'},capabilities:{experimentalApi:true}},1);
 const result=await waitNative(child,{deadlineMs});
 assert(verified&&!failure&&result.code===0&&!result.signal,`capture_setup_failed: ${failure??result.reason??'native_exit'}`);
 console.log(JSON.stringify({type:'evidence',event:'isolated_compaction_configured',hookCount:hooks.length,onlyTemporaryProfile:true,stderrBytes}));
 return {readLogbook,readJournal:()=>readAdmission(mode.directory)};
}
