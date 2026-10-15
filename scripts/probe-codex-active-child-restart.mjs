// Observational CLI 0.160.0 process restart with fixed simulated responses. No installed activation.
import { createHash } from "node:crypto";
import assert from "node:assert/strict";
import http from "node:http";
import { spawn } from "node:child_process";
import { appendFileSync, existsSync, readdirSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { setupCapture } from "./fixtures/codex-native/setup-capture.mjs";
import { restartRpc, restartOutcome, deadline, trackedVersion } from "./fixtures/codex-native/restart-rpc.mjs";
import { resolveRestartBinary } from "./fixtures/codex-native/restart-binary.mjs";
import { cleanupRestart } from "./fixtures/codex-native/restart-cleanup.mjs";
import { validateRestartRegistry, requireRestartReconciliation } from "./fixtures/codex-native/restart-result.mjs";
import { preserveRestartEvidence } from "./fixtures/codex-native/restart-evidence.mjs";
import { freshControlCompletion } from "./fixtures/codex-native/fresh-control.mjs";

import { observeRestartChild } from "./fixtures/codex-native/restart-child.mjs";
const mode=process.argv[2]?.slice(2);
const loadChild=process.argv[3]==="--load-child";
assert((process.argv.length===3 || (process.argv.length===4&&loadChild&&mode==="abrupt-loss")) && ["clean-eof","abrupt-loss"].includes(mode),"Choose --clean-eof or --abrupt-loss");
const root=realpathSync(mkdtempSync(join(tmpdir(),"sage-active-child-restart-")));
const handles=[],pending=new Set(),phases=[];
let chiefParts;
let server,integrated,session,childId,childTurn,prepared,initial,verified=false,failure,stage="setup",responses=0;
let rootRequests=0,childRequests=0,heldResponse,terminal,registry,resumedRegistry,restoredChildRequests=0;
const print=value=>process.stdout.write(JSON.stringify(value)+"\n");
const save=(name,value)=>{const text=JSON.stringify(value,null,2);assert(Buffer.byteLength(text)<=2*1024*1024,"restart_snapshot_bound");writeFileSync(join(root,"restart",name+".json"),text,{mode:0o600});};
let releaseBound,releaseReady,rejectModel;
const bound=new Promise(resolve=>{releaseBound=resolve;});
const ready=new Promise(resolve=>{releaseReady=resolve;});
const modelFailure=new Promise((_,reject)=>{rejectModel=reject;});modelFailure.catch(()=>{});
const wait=(promise,label)=>deadline(Promise.race([promise,modelFailure]),120000,label);
const textItems=value=>typeof value==="string"?[value]:Array.isArray(value)?value.flatMap(textItems):value&&typeof value==="object"?Object.values(value).flatMap(textItems):[];
const output=(request,id)=>{
 const rows=request.input.filter(item=>item.call_id===id&&item.type==="function_call_output");assert.equal(rows.length,1,"missing_exact_tool_result");
 const raw=rows[0].output;const value=typeof raw==="string"?raw:Array.isArray(raw)?raw.at(-1)?.text:undefined;
 assert.equal(typeof value,"string");return JSON.parse(value);
};
const namedTool=(request,name)=>{
 const found=(request.tools??[]).flatMap(tool=>tool.type==="namespace"?(tool.tools??[]).filter(x=>x.name===name).map(x=>({namespace:tool.name,name:x.name})):tool.name===`mcp__sage_preparation__${name}`?[{name:tool.name}]:[]);
 assert.equal(found.length,1,"missing_preparation_tool");return found[0];
};
const call=(id,name,args,namespace="collaboration")=>({type:"function_call",namespace,name,call_id:id,arguments:JSON.stringify(args)});
const message=text=>({type:"message",role:"assistant",content:[{type:"output_text",text,annotations:[]}]});
const respond=(res,item)=>{
 const id=`restart_${++responses}`;item={...item,id:`item_${responses}`,status:"completed"};
 res.writeHead(200,{"Content-Type":"text/event-stream",Connection:"close"});
 for(const event of [{type:"response.created",response:{id,status:"in_progress",output:[]}},
  {type:"response.output_item.done",output_index:0,item},
  {type:"response.completed",response:{id,status:"completed",output:[item],usage:{input_tokens:0,output_tokens:0,total_tokens:0}}}])res.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
 res.end();
};
const snapshot=name=>{
 const value={phase:name,state:integrated.readJournal(),logbook:integrated.readLogbook(),session,childId,childTurn,rootRequests,childRequests,restoredChildRequests};
 if(childId) {
  const file=integrated.interruptionEvidence(childId).transcript;
  const bytes=readFileSync(file);assert(bytes.length<=16*1024*1024,"restart_transcript_bound");
  const lines=bytes.toString("utf8").split("\n"),complete=lines.pop()==="";
  value.childTranscript={bytes:bytes.length,sha256:createHash("sha256").update(bytes).digest("hex"),complete,
   terminalRecords:lines.map(line=>JSON.parse(line)).filter(row=>row.type==="event_msg"&&["turn_aborted","task_complete"].includes(row.payload?.type))};
 }
 save(name,value);phases.push(name);return value;
};
try {
 for(const dir of ["workspace","codex","home","tmp","restart"])mkdirSync(join(root,dir));
 const workspace=join(root,"workspace"),codexHome=join(root,"codex");
 process.env.SAGE_TEST_MACHINE_ID="native-fixture";
 const env={PATH:process.env.PATH,HOME:join(root,"home"),CODEX_HOME:codexHome,TMPDIR:join(root,"tmp"),LANG:"en_US.UTF-8",DO_NOT_TRACK:"1",SAGE_TEST_MACHINE_ID:"native-fixture"};
 const executable=resolveRestartBinary({override:process.env.SAGE_CODEX_BIN});
 save("native-executable",executable);const binary=executable.file;
 const telemetry=["-c","analytics.enabled=false","-c",'otel.exporter="none"',"-c",'otel.metrics_exporter="none"',"-c",'otel.trace_exporter="none"'];
 // Version check owns its handle and waits for close, just like each runtime process.
 const version=spawn(binary,["--version"],{cwd:workspace,env,stdio:["pipe","pipe","pipe"],shell:false});
 const versionOwner=trackedVersion(version);handles.push(versionOwner);versionOwner.eof();
 assert.deepEqual(await deadline(versionOwner.stopped,120000,"version_deadline"),{code:0,signal:null});
 assert.equal(versionOwner.text.trim(),"codex-cli 0.160.0");
 integrated=await setupCapture({root,codexHome,workspace,env,binary,sage:true,captureSessionStart:true});
 const {chiefInstructionParts}=await import(new URL("./plugin/runtime/chief-output.mjs",`file://${root}/`));chiefParts=chiefInstructionParts();
 const catalog=join(root,"models.json");
 writeFileSync(catalog,JSON.stringify({models:[{slug:"sage-restart-fixture",display_name:"Sage restart fixture",supported_reasoning_levels:[],shell_type:"disabled",visibility:"list",supported_in_api:true,priority:1,support_verbosity:false,multi_agent_version:"v2",truncation_policy:{mode:"bytes",limit:10000},experimental_supported_tools:[],tool_mode:"direct",model_messages:{instructions_template:"Follow the fixed restart fixture. Do not use shell or external tools."}}]}));
 server=http.createServer(async(req,res)=>{
  pending.add(res);res.once("close",()=>pending.delete(res));
  try {
   assert.equal(req.method,"POST");assert.equal(req.url,"/v1/responses");let raw="";
   for await(const chunk of req){raw+=chunk;assert(Buffer.byteLength(raw)<=2*1024*1024,"model_request_bound");}
   const request=JSON.parse(raw);assert(Array.isArray(request.input));
   const actor=req.headers["thread-id"];assert.equal(typeof actor,"string");
   if(req.headers["x-openai-subagent"]==="collab_spawn") {
    if(stage==="resume") {assert.equal(actor,childId,"restored_unexpected_child");restoredChildRequests++;return;}
    assert(stage==="establish");childId??=actor;assert.equal(actor,childId);childRequests++;
    if(childRequests===1) {
     const tasks=request.input.filter(item=>item.type==="agent_message");
     assert(tasks.some(item=>item.author==="/root"&&item.recipient==="/root/restart_child"&&item.content?.some(part=>part.type==="encrypted_content"&&part.encrypted_content===prepared.message)),"wrong_child_assignment");
     respond(res,{type:"function_call",name:"list_mcp_resources",call_id:"child_control",arguments:"{}"});
    } else {
     assert.equal(childRequests,2,"extra_child_request");freshControlCompletion(output(request,"child_control"),"control verified");
     const state=integrated.readJournal();assert.equal(state.bindings.length,1);assert.equal(state.bindings[0].child,childId);
     childTurn=state.bindings[0].turn;heldResponse=res;releaseBound();
    }
    return;
   }
   assert.equal(actor,session,"root_identity_changed");rootRequests++;
   if(stage==="establish") {
    if(rootRequests===1) {
     const strings=textItems(request.input);save("initial-instruction-counts",chiefParts.map(part=>strings.reduce((n,text)=>n+text.split(part).length-1,0)));
     const brief=Object.fromEntries(["GOAL","SCOPE","CONTEXT","DECISIONS","ACCEPTANCE","VERIFY","BUDGET","FORBIDDEN","REPORT","STANDING"].map(key=>[key,"Fixed active-child restart observation. Never report completion while held."]));
     respond(res,{type:"function_call",...namedTool(request,"sage_prepare_task"),call_id:"prepare",arguments:JSON.stringify({task:"T1",run:"R1",name:"restart_child",role:"lead",brief})});
    }else if(rootRequests===2){prepared=output(request,"prepare");assert.equal(prepared.decision,"prepared");respond(res,call("spawn","spawn_agent",{task_name:"restart_child",message:prepared.message,fork_turns:"none"}));}
    else if(rootRequests===3){assert.equal(output(request,"spawn").task_name,"/root/restart_child");await wait(bound,"child_control_deadline");respond(res,call("running","list_agents",{}));}
    else {assert.equal(rootRequests,4);registry=validateRestartRegistry(output(request,"running"));assert(registry.agents.some(row=>row.agent_name==="/root/restart_child"&&row.agent_status==="running"));assert(heldResponse&&!heldResponse.writableEnded);initial=snapshot("before-stop");assert.equal(initial.state.reservations.length,1);assert.equal(initial.state.bindings.length,1);assert.equal(initial.state.completions?.length??0,0);assert.equal(initial.logbook.runs[0].status,"running");save("running-registry",registry);releaseReady();}
   }else {
    assert.equal(stage,"resume");
    if(rootRequests===5){const strings=textItems(request.input);save("resumed-instruction-counts",chiefParts.map(part=>strings.reduce((n,text)=>n+text.split(part).length-1,0)));respond(res,call("reconcile","list_agents",{}));}
    else if(rootRequests===6){resumedRegistry=validateRestartRegistry(output(request,"reconcile"));save("resumed-registry",resumedRegistry);snapshot("after-reconcile");respond(res,message("restart observation recorded; no child report or run completion asserted"));}
    else if(loadChild&&rootRequests===7)respond(res,call("reconcile_loaded","list_agents",{}));
    else {assert(loadChild&&rootRequests===8);save("loaded-registry",validateRestartRegistry(output(request,"reconcile_loaded")));snapshot("after-loaded-reconcile");respond(res,message("loaded child observation recorded without a new child turn"));}
   }
  }catch(error){failure??=error.message;rejectModel(error);if(!res.headersSent)res.writeHead(400);res.end("Fixed restart fixture failed");}
 });
 await new Promise((resolve,reject)=>{server.once("error",reject);server.listen(0,"127.0.0.1",resolve);});
 const config={model:"sage-restart-fixture",model_provider:"sage_restart_fixture",model_catalog_json:catalog,cli_auth_credentials_store:"ephemeral","features.hooks":true,"features.plugins":false,"features.remote_plugin":false,"features.apps":false,"features.shell_snapshot":false,"features.shell_tool":false,"features.enable_request_compression":false,"features.multi_agent":true,"features.multi_agent_v2":true,"agents.enabled":true,"agents.max_concurrent_threads_per_session":1,allow_login_shell:false};
 const args=[...telemetry,"app-server"];
 for(const [key,value]of Object.entries(config))args.push("-c",`${key}=${JSON.stringify(value)}`);
 args.push("-c",`model_providers.sage_restart_fixture={name="Sage restart fixture",base_url="http://127.0.0.1:${server.address().port}/v1",wire_api="responses",requires_openai_auth=false,supports_websockets=false}`);
 const connect=async label=>{
  const child=spawn(binary,args,{cwd:workspace,env,stdio:["pipe","pipe","pipe"],shell:false});let size=0;
  const rpc=restartRpc(child,{record:row=>{const text=JSON.stringify(row)+"\n";size+=Buffer.byteLength(text);assert(size<=4*1024*1024,"rpc_capture_bound");appendFileSync(join(root,"restart",label+".jsonl"),text,{mode:0o600});}});handles.push(rpc);
  rpc.events.on("failure",error=>{if(!rpc.closed){failure??=error.message;rejectModel(error);}});
  await wait(rpc.request("initialize",{clientInfo:{name:"sage-restart-fixture",version:"0.1.0"},capabilities:{experimentalApi:true}}),"initialize_deadline");rpc.notify("initialized");return rpc;
 };
 const first=await connect("first");stage="establish";
 const started=await wait(first.request("thread/start",{model:"sage-restart-fixture",modelProvider:"sage_restart_fixture",cwd:workspace,approvalPolicy:"never",sandbox:"read-only"}),"thread_start_deadline");
 session=started.thread.id;assert.equal(typeof session,"string");
 await wait(first.request("turn/start",{threadId:session,input:[{type:"text",text:"sage mode",text_elements:[]}]}),"turn_start_deadline");
 await wait(ready,"running_barrier_deadline");stage="stop";
 if(mode==="clean-eof")first.eof();else first.abrupt();
 terminal=await deadline(first.stopped,120000,"stop_not_terminal");save("stop-result",{mode,terminal,outcome:restartOutcome(mode,terminal)});
 assert.equal(restartOutcome(mode,terminal),mode==="clean-eof"?"clean-exit":"tracked-abrupt-exit","stop_mode_not_observed");
 snapshot("after-stop");for(const res of pending)res.destroy();
 stage="resume";const second=await connect("second");
 const resumed=await wait(second.request("thread/resume",{threadId:session,model:"sage-restart-fixture",modelProvider:"sage_restart_fixture",cwd:workspace,approvalPolicy:"never",sandbox:"read-only"}),"thread_resume_deadline");
 assert.equal(resumed.thread.id,session,"resume_changed_root");save("resume-result",resumed);snapshot("after-resume");
 const completed=new Promise(resolve=>{const listener=event=>{if(event.method==="turn/completed"&&event.params?.threadId===session){second.events.off("notification",listener);resolve(event.params);}};second.events.on("notification",listener);});
 await wait(second.request("turn/start",{threadId:session,input:[{type:"text",text:"Observe the fixed restart fixture through the parent registry only.",text_elements:[]}]}),"resume_turn_deadline");
 const end=await wait(completed,"resume_observation_deadline");save("resume-turn",end);
 assert.equal(end.turn?.status,"completed");
 requireRestartReconciliation(rootRequests,resumedRegistry,phases);
 if(loadChild) {
  await observeRestartChild((method,params)=>wait(second.request(method,params),"child_observation_deadline"),childId,childTurn,save);
  snapshot("after-child-load");
  const loadedCompleted=new Promise(resolve=>{const listener=event=>{if(event.method==="turn/completed"&&event.params?.threadId===session){second.events.off("notification",listener);resolve(event.params);}};second.events.on("notification",listener);});
  await wait(second.request("turn/start",{threadId:session,input:[{type:"text",text:"Observe the loaded child through the parent registry only.",text_elements:[]}]}),"loaded_parent_turn_deadline");
  assert.equal((await wait(loadedCompleted,"loaded_reconciliation_deadline")).turn?.status,"completed");
  assert.equal(rootRequests,8);assert(phases.includes("after-loaded-reconcile"));
 }
 const final=snapshot("observed");assert.deepEqual(final.logbook,initial.logbook,"restart_changed_logbook");
 assert.deepEqual(final.state.reservations,initial.state.reservations,"restart_changed_assignments");
 assert.deepEqual(final.state.bindings,initial.state.bindings,"restart_changed_bindings");
 assert.deepEqual(final.state.sessions,initial.state.sessions,"restart_changed_owner");
 assert.equal(final.state.reports?.length??0,0);assert.equal(final.state.failures?.length??0,0);
 const completions=final.state.completions??[];assert(completions.length<=1);
 if(completions.length){
  assert.equal(completions[0].outcome,"interrupted","unexpected_successful_child_completion");
  const evidence=integrated.interruptionEvidence(childId);
  const {readNativeInterruption}=await import("../packages/sage-codex/runtime/identity.mjs");
  const receipt=readNativeInterruption(evidence.transcript,{sessionsDir:join(codexHome,"sessions")},evidence.expected);
  assert.equal(receipt.evidenceHash,completions[0].evidenceHash,"release_without_exact_native_terminal");
 }
 const sessionStarts=readdirSync(join(root,"events")).map(name=>JSON.parse(readFileSync(join(root,"events",name),"utf8"))).filter(row=>row.hook_event_name==="SessionStart");
 save("session-start-observations",{available:sessionStarts.length>0,events:sessionStarts});
 save("observation-summary",{sessionStartCount:sessionStarts.length,mode,sameRoot:true,terminal,childRestoredModelRequests:restoredChildRequests,completionCount:completions.length,reservationRetained:true,capacityReleased:completions.length===1,followupAttempted:false,followupReason:"No completed public report predecessor was obtained; continuation was not authorized.",simulatedModel:true,automaticSage:false});
 second.eof();const resumedExit=await deadline(second.stopped,120000,"resumed_process_not_terminal");assert.deepEqual(resumedExit,{code:0,signal:null});verified=true;
}catch(error){failure??=error.message;print({type:"restart_failure",stage,reason:failure});process.exitCode=1;}
finally {
 const cleanup=await cleanupRestart({handles,
  capture:()=>preserveRestartEvidence(root,{task:"T4",mode,loadChild,stage,verified,failure:failure??null,phases,terminal,simulatedModel:true,automaticSage:false}),
  closeResponses:()=>{const errors=[];for(const res of pending)try{res.destroy();}catch(error){errors.push(error.message);}try{server?.closeAllConnections();}catch(error){errors.push(error.message);}if(errors.length)throw Error(errors.join("; "));},
  closeServer:()=>server?new Promise((resolve,reject)=>server.close(error=>error?reject(error):resolve())):Promise.resolve(),
  removeRoot:()=>rmSync(root,{recursive:true,force:true}),
 });
 if(cleanup.evidence)print({type:"restart_evidence",...cleanup.evidence});
 if(!cleanup.complete || existsSync(root))process.exitCode=1;
 print({type:"cleanup",temporaryRootRemoved:!existsSync(root),ownedHandlesClosed:cleanup.ownedHandlesClosed,
  errors:cleanup.errors,...(existsSync(root)?{retainedRoot:root}:{})});
}
