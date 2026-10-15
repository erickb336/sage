import { test } from "node:test";
import assert from "node:assert/strict";
import { requireRestartReconciliation } from "./restart-result.mjs";
test("restart verified result requires the explicit successful resumed registry phase",()=>{
 const registry={agents:[{agent_name:"/root",agent_status:"running"}]};
 assert.deepEqual(requireRestartReconciliation(6,registry,["after-reconcile"]),registry);
 assert.throws(()=>requireRestartReconciliation(5,registry,["after-reconcile"]),/phase_missing/);
 assert.throws(()=>requireRestartReconciliation(6,registry,[]),/snapshot_missing/);
 for(const denied of [undefined,{error:"denied"},{agents:[],error:"denied"},{agents:[]},{agents:[{agent_name:"/root"}]}])
 assert.throws(()=>requireRestartReconciliation(6,denied,["after-reconcile"]),/restart_registry/);
});
