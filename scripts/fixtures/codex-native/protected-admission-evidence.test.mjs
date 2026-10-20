import test from "node:test";
import assert from "node:assert/strict";
import {spawnSync} from "node:child_process";
import {createHash} from "node:crypto";
import {fileURLToPath} from "node:url";
const hash=value=>createHash("sha256").update(value).digest("hex");
function original(scenario){
 const binding={assignment:"11111111-1111-4111-8111-111111111111",session:"codex:22222222-2222-4222-8222-222222222222",epoch:"epoch",issuer:"22222222-2222-4222-8222-222222222222",child:"33333333-3333-4333-8333-333333333333",turn:"44444444-4444-4444-8444-444444444444"};
 const before={sessions:[{session:binding.session,epoch:binding.epoch,activation:"parent-turn"}],preparations:[{id:"prepared"}],reservations:[{assignment:{id:binding.assignment},preparation:"prepared",dispatch:{taskHash:hash("saved task")}}],bindings:[binding]};
 const bookBefore={tasks:[{id:"T1",branch:"codex/t1-native"}],runs:[{id:"R1",status:"running",report:"",ended:""}],ledger:[]};
 const terminal={session:binding.issuer,child:binding.child,turn:binding.turn,taskHash:hash("saved task"),text:"sample terminal report",reportMessage:"message_1",reportHash:hash("sample terminal report")};
 const nativeIdentity={...terminal,parent:binding.issuer,path:"/root/probe_child",author:"/root"};
 const retarget=scenario==="active-retarget",call=retarget?"protected_update":"protected_finish";
 const request=retarget?{request:"55555555-5555-4555-8555-555555555555",task:"T1",version:hash(JSON.stringify(bookBefore.tasks[0])),changes:{branch:"codex/t1-retargeted"}}:{assignment:binding.assignment,reportHash:terminal.reportHash};
 const result=retarget?{decision:"task-update-rejected",reason:`Reconcile or interrupt these assignments first: ${binding.assignment}`} : "Sage could not finish this run. Check the chief identity, saved report, assigned run, and configured logbook.";
 const after=structuredClone(before);if(retarget)after.taskUpdates=[{update:{request:request.request,task:"T1",session:binding.session,disruptive:true},accepted:false,reason:result.reason}];
 const finish={decision:"run-finished",task:"T1",run:"R1",status:"done",report:"reports/sample.md",ended:"sample-end"};
 return {scenario,before,after,bookBefore,bookAfter:structuredClone(bookBefore),nativeIdentity,request,result,call,childRequests:3,terminal,
  events:[{hook_event_name:"SubagentStart"},...(retarget?["PreToolUse","PostToolUse"]:["PreToolUse"]).map(hook_event_name=>({hook_event_name,tool_use_id:call,session_id:binding.issuer,turn_id:"parent-turn",tool_name:`mcp__sage_preparation__sage_${retarget?"update_task":"finish_run"}`,toolInput:request}))],
  final:{...structuredClone(after),completions:[structuredClone(binding)],reports:[{binding:structuredClone(binding),reportHash:terminal.reportHash,text:terminal.text,run:"R1"}]},
  finalBook:{...structuredClone(bookBefore),runs:[{...bookBefore.runs[0],status:"done",report:finish.report,ended:finish.ended}]},finish};
}
const replay=input=>spawnSync(process.execPath,[fileURLToPath(new URL("../../probe-codex-lifecycle.mjs",import.meta.url)),"--protected-admission-evidence"],{input:JSON.stringify(input),encoding:"utf8",env:process.env});
for(const scenario of ["active-retarget","premature-finish"])test(`protected native admission consistency: ${scenario}`,()=>{
 const good=replay(original(scenario));assert.equal(good.status,0,good.stderr);assert.deepEqual(JSON.parse(good.stdout),{scenario,refused:true,originalTargetPreserved:true,reportIdentityPreserved:true,finishedRuns:1});
 const mutations=[v=>v.scenario="other",v=>v.call="wrong",v=>v.before.bindings.push({}),v=>v.after.reservations.push({}),v=>v.bookAfter.tasks[0].branch="changed",v=>v.terminal.child="wrong",v=>v.terminal.turn="wrong",v=>v.terminal.taskHash=hash("wrong"),v=>v.nativeIdentity.parent="wrong",v=>v.nativeIdentity.path="/root/wrong",v=>v.events[1].session_id="wrong",v=>v.events[1].turn_id="wrong",v=>v.events[1].tool_name="wrong",v=>v.events[1].toolInput={unexpected:true},v=>v.events.push({...v.events[1]}),v=>v.final.reports[0].text="wrong",v=>v.final.completions[0].assignment="wrong",v=>v.finish.status="failed",v=>v.finalBook.runs[0].report="wrong",v=>v.childRequests=4];
 if(scenario==="active-retarget")mutations.push(v=>v.result.decision="task-updated",v=>v.after.taskUpdates[0].accepted=true,v=>v.after.taskUpdates[0].update.request="wrong",v=>v.after.taskUpdates[0].reason="wrong");
 else mutations.push(v=>v.request.reportHash=hash("wrong"),v=>v.result="run-finished",v=>v.result="Sage could not finish: a different refusal",v=>v.events.push({...v.events[1],hook_event_name:"PostToolUse"}));
 for(const[index,mutate]of mutations.entries()){
  const input=original(scenario);mutate(input);const bad=replay(input);assert.equal(bad.status,1,`${scenario} mutation${index+1} accepted`);assert.equal(bad.stdout,"");assert.match(bad.stderr,/AssertionError/);
 }
});
