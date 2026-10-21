import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';

// Compare independent native transcript evidence, journal identity, parent receipts,
// and hook observations. A callback or saved binding alone never proves completion.
export function validateCompletionRecovery({state, native, receipts, callbacks, observations, events, child, session, omitStop, secondNoTool}) {
  assert.equal(typeof omitStop,'boolean','callback mode');assert.equal(typeof secondNoTool,'boolean','tool mode');
  assert.equal(typeof child,'string');assert(child.length>0);assert.equal(typeof session,'string');assert(session.length>0);
  for (const key of ['reservations','bindings','completions','reports']) assert.equal(state[key].length,2,key);
  assert.equal(native.length,2,'native completions');
  assert.equal(receipts.length,2,'parent receipts');
  assert.equal(new Set(state.bindings.map(row=>row.assignment)).size,2,'distinct assignments');
  assert.equal(new Set(state.bindings.map(row=>row.turn)).size,2,'distinct native turns');
  assert.equal(callbacks.length,omitStop ? 0 : 2,'Sage callbacks');
  const stops=observations.filter(row=>row.kind==='child-stop');
  assert.equal(stops.length,omitStop ? 0 : 2,'stored callbacks');
  assert.equal(state.reservations[1].continuation,state.bindings[0].assignment,'continuation');
  for (const [index,bound] of state.bindings.entries()) {
    const reservation=state.reservations[index], evidence=native[index], receipt=receipts[index], saved=state.reports[index];
    assert.equal(bound.child,child,'exact child');assert.equal(bound.session,`codex:${session}`,'exact session');
    assert.equal(reservation.assignment.id,bound.assignment,'exact reservation');
    assert.deepEqual(state.completions[index],bound,'exact completion');
    assert.equal(evidence.child,child,'native child');assert.equal(evidence.session,session,'native session');
    assert.equal(evidence.turn,bound.turn,'native turn');
    assert.equal(evidence.taskHash,reservation.dispatch.taskHash,'native assignment hash');
    assert.equal(typeof evidence.reportMessage,'string','native terminal message');assert(evidence.reportMessage.length>0);
    assert.equal(evidence.reportHash,createHash('sha256').update(evidence.text).digest('hex'),'native report hash');
    assert.equal(receipt.decision,'report-recorded');assert.equal(receipt.assignment,bound.assignment);
    assert.equal(receipt.child,child);assert.equal(receipt.turn,bound.turn);
    assert.equal(receipt.task,reservation.assignment.task);assert.equal(receipt.run,reservation.assignment.run);
    assert.equal(receipt.reportMessage,evidence.reportMessage);assert.equal(receipt.reportHash,evidence.reportHash);
    assert.deepEqual(saved.binding,bound);assert.equal(saved.text,evidence.text);
    assert.equal(saved.reportHash,receipt.reportHash);assert.equal(saved.reportMessage,receipt.reportMessage);
    if(!omitStop) {
      const stop=stops.filter(row=>row.child===child&&row.turn===bound.turn);assert.equal(stop.length,1,'exact callback');
      assert.equal(callbacks[index].decision,'stop-observed');assert.equal(callbacks[index].completions,index);
    }
  }
  assert.notEqual(receipts[0].reportMessage,receipts[1].reportMessage,'distinct reports');
  const tools=events.filter(row=>row.hook_event_name==='PreToolUse'&&row.turn_id===state.bindings[1].turn);
  assert.equal(tools.length,secondNoTool ? 0 : 1,'second turn tools');
  if(!secondNoTool) assert.equal(tools[0].tool_name,'list_mcp_resources');
  return {assignments:2,nativeCompletions:2,receipts:2,callbacks:callbacks.length,secondTurnTools:tools.length};
}
