import assert from "node:assert/strict";

export function validateRestartRegistry(registry) {
 assert(registry && typeof registry==="object" && !Array.isArray(registry)
  && Object.keys(registry).length===1 && Array.isArray(registry.agents),"restart_registry_not_successful");
 const names=new Set();
 for(const row of registry.agents) {
  assert(row && typeof row==="object" && Object.keys(row).length===2
   && typeof row.agent_name==="string" && /^\/root(?:\/[a-z0-9_]+)*$/.test(row.agent_name)
   && !names.has(row.agent_name),"restart_registry_invalid_agent");
  names.add(row.agent_name);
  assert(typeof row.agent_status==="string" || (row.agent_status && typeof row.agent_status==="object"
   && !Array.isArray(row.agent_status) && Object.keys(row.agent_status).length===1
   && Object.values(row.agent_status).every(value=>typeof value==="string")),"restart_registry_invalid_status");
 }
 assert(names.has("/root"),"restart_registry_missing_root");return registry;
}

export function requireRestartReconciliation(rootRequests, registry, phases) {
 assert.equal(rootRequests,6,"restart_reconciliation_phase_missing");
 assert(phases.includes("after-reconcile"),"restart_reconciliation_snapshot_missing");
 return validateRestartRegistry(registry);
}
