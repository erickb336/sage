import { test } from "node:test";
import assert from "node:assert/strict";
import { assertPatchEvidence } from "./patch-evidence.mjs";
function trial(kind) {
  const chief=kind==="chief",protectedTarget=kind==="protected",denied=chief||protectedTarget;
  const reason=chief?"This Sage role cannot edit files. Give the change to an implementer.":"This patch reaches a protected path or a file with another hard link. Use the authorized state operation for logbook changes.";
  const identity={session_id:"session",turn_id:"turn",tool_use_id:"fixed_patch",tool_name:"apply_patch"};
  return {chief,protectedTarget,commandResult:denied?`Tool refused: ${reason}`:"Success. Updated the following files:\nA ordinary.txt",
    events:[{...identity,hook_event_name:"PreToolUse"},...denied?[]:[{...identity,hook_event_name:"PostToolUse"}]],
    items:[{type:"thread.started",thread_id:"session"},{type:"turn.completed"},
      {type:"item.completed",item:{type:"agent_message",text:"patch boundary checked"}},
      ...denied?[]:[{type:"item.completed",item:{type:"file_change"}}]],
    receipt:chief?null:{session:"session",turn:"turn",call:"fixed_patch",sage:false,result:protectedTarget?{decision:"deny",reason}:{decision:"pass"}},
    fileContents:denied?null:"fixed native patch\n"};
}
for(const kind of ["ordinary","protected","chief"])test(`native patch evidence accepts ${kind} trial`,()=>assertPatchEvidence(trial(kind)));
for(const [name,kind,mutate] of [
  ["missing actual success","ordinary",data=>data.commandResult=""],
  ["wrong file contents","ordinary",data=>data.fileContents="different\n"],
  ["unrelated denial","protected",data=>data.commandResult="sandbox denied"],
  ["missing policy receipt","protected",data=>data.receipt=null],
  ["wrong receipt call","protected",data=>data.receipt.call="other"],
  ["wrong receipt turn","protected",data=>data.receipt.turn="other"],
  ["wrong native session","protected",data=>data.items[0].thread_id="other"],
  ["post hook after denial","protected",data=>data.events.push({...data.events[0],hook_event_name:"PostToolUse"})],
  ["callback bypassing role guard","chief",data=>data.receipt=trial("ordinary").receipt],
  ["wrong role denial","chief",data=>data.commandResult="protected path"],
  ["file despite denial","chief",data=>data.fileContents="fixed native patch\n"]
])test(`native patch evidence refuses ${name}`,()=>{const data=trial(kind);mutate(data);assert.throws(()=>assertPatchEvidence(data));});

import { mkdtempSync, mkdirSync, readFileSync, rmSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { setupCompletion } from "./setup-completion.mjs";
import { trackOwnerProcess } from "./owner-turns.mjs";

for (const protectedTarget of [false, true]) test(`generated patch fixture evaluates actual ${protectedTarget ? "protected denial" : "ordinary pass"}`, async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "sage-patch-composition-")));
  let handle;
  try {
    mkdirSync(join(root,"workspace")); mkdirSync(join(root,"codex"));
    const env = {...process.env,SAGE_TEST_MACHINE_ID:"native-fixture"};
    await setupCompletion(root,{patchProbe:true,env});
    const child=spawn(process.execPath,[join(root,"completion-hooks.mjs")],{env,stdio:["pipe","pipe","pipe"],shell:false});
    handle=trackOwnerProcess(child);
    let next=0,stderr=""; const pending=new Map();
    child.stderr.on("data",data=>{stderr+=data;});
    createInterface({input:child.stdout}).on("line",line=>{const row=JSON.parse(line);pending.get(row.id)?.resolve(row);pending.delete(row.id);});
    handle.stopped.then(()=>{for(const item of pending.values())item.reject(Error("server closed"));});
    const request=(method,params)=>new Promise((resolve,reject)=>{const id=++next;pending.set(id,{resolve,reject});child.stdin.write(JSON.stringify({jsonrpc:"2.0",id,method,params})+"\n");});
    const init=await request("initialize",{protocolVersion:"2025-06-18",capabilities:{},clientInfo:{name:"codex",version:"0.160.0"}});
    assert.equal(init.result.protocolVersion,"2025-06-18");
    child.stdin.write(JSON.stringify({jsonrpc:"2.0",method:"notifications/initialized"})+"\n");
    const session="d72422c7-509c-43aa-8c42-827c556f8a57",turn="e22422c7-509c-43aa-8c42-827c556f8a57";
    const target=protectedTarget?join(root,"logbook/forbidden.txt"):"ordinary.txt";
    const response=await request("tools/call",{name:"sage_native_hook",_meta:{threadId:session},arguments:{
      hook_event_name:"PreToolUse",session_id:session,turn_id:turn,tool_use_id:"fixed_patch",tool_name:"apply_patch",
      tool_input:{command:`*** Begin Patch\n*** Add File: ${target}\n+fixed native patch\n*** End Patch`}}});
    assert.equal(response.error,undefined);assert.equal(response.result.isError,undefined);
    const output=JSON.parse(response.result.content[0].text);
    const saved=JSON.parse(readFileSync(join(root,"patch-policy-receipt.json"),"utf8"));
    assert.deepEqual(saved,{session,turn,call:"fixed_patch",sage:false,role:null,result:protectedTarget
      ?{decision:"deny",reason:"This patch reaches a protected path or a file with another hard link. Use the authorized state operation for logbook changes."}
      :{decision:"pass"}});
    if(protectedTarget) assert.equal(output.hookSpecificOutput.permissionDecisionReason,saved.result.reason);
    else assert.deepEqual(output,{});
    child.stdin.end();assert.equal((await handle.stopped).code,0);assert.equal(stderr,"");
  } finally {
    if(handle&&!handle.closed){handle.eof();await handle.stopped;}
    rmSync(root,{recursive:true,force:true});
  }
});
