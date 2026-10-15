import assert from "node:assert/strict";

// Loading uses only the recorded identity. Displayed interrupted status is not a receipt.
export async function observeRestartChild(request, childId, turnId, record) {
 const loaded=await request("thread/resume",{threadId:childId});
 assert.equal(loaded.thread?.id,childId,"restart_loaded_wrong_child");
 record("child-load-result",loaded);
 const turns=loaded.thread.turns;
 assert(Array.isArray(turns),"restart_child_turns_missing");
 const active=turns.filter(turn=>turn.status==="inProgress");
 assert(active.length<=1,"restart_child_multiple_active_turns");
 if(active.length)assert.equal(active[0].id,turnId,"restart_child_active_turn_changed");
 if(!active.length){const result={interruptAttempted:false,reason:"saved turn is not reported active",persistedReceiptRequired:true};record("child-interrupt-result",result);return result;}
 try {
  const response=await request("turn/interrupt",{threadId:childId,turnId});
  const result={interruptAttempted:true,response,persistedReceiptRequired:true};record("child-interrupt-result",result);return result;
 }catch(error){const result={interruptAttempted:true,requestError:String(error.message),outcomeUnknown:true,persistedReceiptRequired:true};record("child-interrupt-result",result);return result;}
}
