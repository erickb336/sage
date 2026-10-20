import assert from "node:assert/strict";
import {createHash} from "node:crypto";
const hash=value=>createHash("sha256").update(value).digest("hex");
const omit=(value,keys)=>Object.fromEntries(Object.entries(value).filter(([key])=>!keys.includes(key)));
// Consistency only. The native caller authenticates the terminal transcript before this check.
export function validateProtectedAdmissionEvidence(input) {
  const {scenario,before,after,bookBefore,bookAfter,request,result,call,events,terminal,final,finalBook,finish,childRequests}=input;
  const retarget=scenario==="active-retarget";assert(retarget||scenario==="premature-finish");
  assert.equal(call,retarget?"protected_update":"protected_finish");
  for(const key of ["preparations","reservations","bindings"])assert.equal(before[key].length,1);
  assert.equal((before.completions??[]).length,0);assert.equal((before.reports??[]).length,0);
  const bound=before.bindings[0],reserved=before.reservations[0],prepared=before.preparations[0];
  assert.equal(bound.assignment,reserved.assignment.id);assert.equal(prepared.id,reserved.preparation);
  for(const key of ["session","child","turn"])assert.equal(terminal[key],key==="session"?bound.session.slice(6):bound[key]);
  assert.equal(input.nativeIdentity.parent,bound.issuer);assert.equal(input.nativeIdentity.author,"/root");assert.equal(input.nativeIdentity.path,"/root/probe_child");
  for(const key of ["session","child","turn","taskHash"])assert.equal(input.nativeIdentity[key],terminal[key]);assert.equal(terminal.taskHash,reserved.dispatch.taskHash);
  assert.equal(terminal.reportHash,hash(terminal.text));assert.match(terminal.reportMessage,/^[A-Za-z0-9_-]{1,256}$/);
  const observed=events.filter(row=>row.tool_use_id===call),pre=observed.filter(row=>row.hook_event_name==="PreToolUse"),post=observed.filter(row=>row.hook_event_name==="PostToolUse");
  assert.equal(pre.length,1);assert.equal(post.length,retarget?1:0);
  const owner=before.sessions.find(row=>row.session===bound.session && row.epoch===bound.epoch);assert(owner);
  for(const event of observed){assert.equal(event.turn_id,owner.activation);assert.equal(event.session_id,bound.session.slice(6));assert.equal(event.agent_id??event.session_id,bound.issuer);assert.equal(event.tool_name,`mcp__sage_preparation__sage_${retarget?"update_task":"finish_run"}`);assert.deepEqual(event.toolInput,request);}
  assert.equal(childRequests,3);assert.equal(events.filter(row=>row.hook_event_name==="SubagentStart").length,1);
  assert.deepEqual(bookAfter,bookBefore);
  assert.equal(bookBefore.runs.length,1);assert.equal(bookBefore.runs[0].status,"running");assert.equal(bookBefore.runs[0].report,"");assert.equal(bookBefore.runs[0].ended,"");
  if(retarget){
    assert.deepEqual(Object.keys(request).sort(),["changes","request","task","version"]);
    assert.equal(request.task,"T1");assert.equal(request.version,hash(JSON.stringify(bookBefore.tasks[0])));assert.deepEqual(request.changes,{branch:"codex/t1-retargeted"});
    assert.match(request.request,/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/);
    assert.deepEqual(result,{decision:"task-update-rejected",reason:`Reconcile or interrupt these assignments first: ${bound.assignment}`});
    assert.deepEqual(omit(after,["taskUpdates"]),omit(before,["taskUpdates"]));assert.equal((before.taskUpdates??[]).length,0);assert.equal(after.taskUpdates.length,1);
    const saved=after.taskUpdates[0];assert.equal(saved.update.request,request.request);assert.equal(saved.update.task,"T1");assert.equal(saved.update.session,bound.session);assert.equal(saved.update.disruptive,true);assert.equal(saved.accepted,false);assert.equal(saved.reason,result.reason);assert.equal(saved.released,undefined);
  }else{
    assert.deepEqual(request,{assignment:bound.assignment,reportHash:terminal.reportHash});assert.equal(result,"Sage could not finish this run. Check the chief identity, saved report, assigned run, and configured logbook.");assert.deepEqual(after,before);
  }
  assert.deepEqual(final.bindings,before.bindings);assert.equal(final.completions.length,1);assert.deepEqual(final.completions[0],bound);assert.equal(final.reports.length,1);
  assert.deepEqual(omit(final,["completions","reports"]),omit(after,["completions","reports"]));
  const report=final.reports[0];assert.deepEqual(report.binding,bound);assert.equal(report.reportHash,terminal.reportHash);assert.equal(report.text,terminal.text);assert.equal(report.run,"R1");
  assert.equal(finish.decision,"run-finished");assert.equal(finish.task,"T1");assert.equal(finish.run,"R1");assert.equal(finish.status,"done");
  assert.deepEqual(finalBook,{...bookBefore,runs:[{...bookBefore.runs[0],status:"done",report:finish.report,ended:finish.ended}]});
  return {scenario,refused:true,originalTargetPreserved:true,reportIdentityPreserved:true,finishedRuns:1};
}
