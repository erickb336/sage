import assert from "node:assert/strict";
import {createHash} from "node:crypto";
const hash = text => createHash("sha256").update(text).digest("hex");
export const WORKFLOW_SCENARIOS = ["--sage-task-lifecycle", "--sage-off-stop", "--sage-report-correction", "--sage-report-escape"];
// Portable consistency only. Native callers must authenticate through current policy and report readers first.
export function verifyWorkflowEvidence(evidence) {
  const {scenario, journal:state, book, stops, native} = evidence;
  assert(WORKFLOW_SCENARIOS.includes(scenario));
  assert.equal(native.exactMessages,1);assert.equal(native.completedTurns,1);
  for(const key of ["failedTurns","unexpectedItems","malformedEvents","rejectedRequests"]) assert.equal(native[key],0);
  assert.equal(native.code,0);assert.equal(native.signal,null);assert.notEqual(native.parent,native.child);
  assert.equal(book.tasks.length,1);assert.equal(book.runs.length,1);assert.equal(book.ledger.length,0);
  const off=scenario===WORKFLOW_SCENARIOS[1], escape=scenario===WORKFLOW_SCENARIOS[3];
  assert.equal(native.childRequests,off?1:2);
  assert.equal(stops.length,off?1:2);
  assert.equal(state.reservations.length,off?0:1);assert.equal(state.bindings.length,off?0:1);
  assert.equal((state.completions??[]).length,off?0:1);assert.equal((state.reports??[]).length,off||escape?0:1);
  if(off) {
    // This is a consistency join, not authentication of replayed JSON. The native caller derives
    // offIdentity through readInitialSession/readChildTurn before it invokes this helper.
    const identity=evidence.offIdentity,uuid=/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/;
    for(const key of ["session","parent","child","turn"]) assert.match(identity[key],uuid);
    assert.equal(identity.parent,native.parent);assert.equal(identity.session,native.parent);assert.equal(identity.child,native.child);
    assert.notEqual(identity.turn,identity.child);assert.notEqual(identity.turn,identity.session);assert.equal(identity.path,"/root/probe_child");
    assert.equal(stops[0].child,identity.child);assert.equal(stops[0].session,identity.session);assert.equal(stops[0].turn,identity.turn);
    assert.equal(evidence.baselineHashes.length,2);assert.match(evidence.baselineHashes[0],/^[a-f0-9]{64}$/);assert.equal(evidence.baselineHashes[0],evidence.baselineHashes[1]);assert.equal(state.modes.at(-1).sage,false);
    assert.equal(book.runs[0].status,"running");assert.equal(book.runs[0].ended,"");assert.equal(book.runs[0].report,"");
    assert.equal(stops[0].decision,"unmanaged");assert.equal(stops[0].completions,0);
  } else {
    const bound=state.bindings[0], reserved=state.reservations[0];
    assert.equal(bound.child,native.child);assert.equal(bound.issuer,native.parent);assert.equal(reserved.assignment.id,bound.assignment);
    assert.deepEqual(state.completions[0],bound);
    for(const stop of stops) {
      assert.equal(stop.decision,"stop-observed");assert.equal(stop.completions,0);
      assert.equal(stop.child,bound.child);assert.equal(stop.turn,bound.turn);assert.equal(`codex:${stop.session}`,bound.session);
      assert.match(stop.reportHash,/^[a-f0-9]{64}$/);
    }
    if(escape) {
      assert.equal(stops[0].reportHash,stops[1].reportHash);
      assert.equal(book.runs[0].status,"running");assert.equal(book.runs[0].ended,"");assert.equal(book.runs[0].report,"");
      const final=evidence.results.at(-1);
      assert.match(final.workflow_0,/Sage could not read/);assert.match(final.workflow_1,/Sage could not finish/);
    } else {
      const report=state.reports[0];
      assert.deepEqual(report.binding,bound);assert.equal(report.run,book.runs[0].id);
      assert.equal(report.reportHash,hash(report.text));assert.equal(report.reportHash,stops[1].reportHash);
      assert.equal(book.runs[0].status,"done");assert(book.runs[0].ended);assert(book.runs[0].report);
      if(scenario===WORKFLOW_SCENARIOS[2]) assert.notEqual(stops[0].reportHash,report.reportHash);
      else {
        assert.deepEqual(evidence.transitions.map(row=>[row.from,row.to]),[["framed","briefed"],["briefed","building"],["building","reviewing"],["reviewing","verifying"]]);
        assert.equal(book.tasks[0].state,"verifying");assert.equal(state.taskUpdates.length,4);
        assert.equal(new Set(evidence.transitions.map(row=>row.request)).size,4);
        const final=evidence.results.at(-1);
        for(const [offset,target] of [[0,"briefed"],[3,"building"],[10,"reviewing"],[13,"verifying"]]) {
          const update=final[`workflow_${offset+1}`],retry=final[`workflow_${offset+2}`];
          assert.equal(update.decision,"task-updated");assert.equal(update.task.state,target);
          assert.deepEqual(retry,{...update,decision:"task-update-history"});
          assert.equal(state.taskUpdates.filter(row=>row.update.request===evidence.transitions.find(row=>row.to===target).request && row.accepted && row.released).length,1);
        }
        assert.match(final.workflow_17,/\[readiness\]/);
        const finished=evidence.results.findIndex(row=>row.probe_finish?.decision==="run-finished"),reviewing=evidence.results.findIndex(row=>row.workflow_11);
        assert(finished>=0 && reviewing>finished);
      }
    }
  }
  return {scenario,transitions:evidence.transitions.length,stops:stops.length,reports:(state.reports??[]).length,runStatus:book.runs[0].status};
}
