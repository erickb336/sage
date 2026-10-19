import test from "node:test";
import assert from "node:assert/strict";
import {spawnSync} from "node:child_process";
import {createHash} from "node:crypto";
import {WORKFLOW_SCENARIOS} from "./workflow-evidence.mjs";
const parent="11111111-1111-4111-8111-111111111111",child="22222222-2222-4222-8222-222222222222",turn="33333333-3333-4333-8333-333333333333";
const other="44444444-4444-4444-8444-444444444444";
const digest=text=>createHash("sha256").update(text).digest("hex");
function fixture(scenario) {
  const off=scenario===WORKFLOW_SCENARIOS[1],escape=scenario===WORKFLOW_SCENARIOS[3],life=scenario===WORKFLOW_SCENARIOS[0];
  const binding={assignment:"assignment-1",child,issuer:parent,turn,session:`codex:${parent}`};
  const text="STATUS done\nRESULT sample",reportHash=digest(text);
  const stops=Array.from({length:off?1:2},(_,i)=>({decision:off?"unmanaged":"stop-observed",completions:0,child:binding.child,turn:binding.turn,session:parent,reportHash:i===0&&scenario===WORKFLOW_SCENARIOS[2]?digest("incomplete"):reportHash}));
  const transitions=life?["briefed","building","reviewing","verifying"].map((to,i,all)=>({from:i?all[i-1]:"framed",to,request:`request-${i}`})):[];
  const final=escape?{workflow_0:"Sage could not read this report.",workflow_1:"Sage could not finish this run."}:{};
  for(const [index,offset] of [0,3,10,13].entries()) {
    if(!life)break;
    const update={decision:"task-updated",task:{state:transitions[index].to}};
    final[`workflow_${offset+1}`]=update;final[`workflow_${offset+2}`]={...update,decision:"task-update-history"};
  }
  if(life)final.workflow_17="Sage could not update this task. [readiness]";
  const run={id:"R1",status:off||escape?"running":"done",ended:off||escape?"":"sample-end",report:off||escape?"":"reports/sample.md"};
  return {offIdentity:off?{session:parent,parent,child,turn,path:"/root/probe_child"}:null,scenario,transitions,stops,baselineHashes:off?[digest("before"),digest("before")]:null,
    native:{code:0,signal:null,parent,child,childRequests:off?1:2,exactMessages:1,completedTurns:1,failedTurns:0,unexpectedItems:0,malformedEvents:0,rejectedRequests:0},
    book:{tasks:[{state:life?"verifying":"framed"}],runs:[run],ledger:[]},
    journal:{modes:[{sage:!off}],reservations:off?[]:[{assignment:{id:binding.assignment}}],bindings:off?[]:[binding],completions:off?[]:[binding],reports:off||escape?[]:[{binding,run:"R1",text,reportHash}],taskUpdates:transitions.map(row=>({update:{request:row.request},accepted:true,released:true}))},
    results:life?[{probe_finish:{decision:"run-finished"}},final]:[final]};
}
const probe = new URL("../../probe-codex-lifecycle.mjs",import.meta.url);
function replay(value) { return spawnSync(process.execPath,[probe.pathname,"--workflow-evidence"],{input:JSON.stringify(value),encoding:"utf8",env:process.env}); }
for(const scenario of WORKFLOW_SCENARIOS) test(`portable workflow consistency: ${scenario}`,()=>{
  const value=fixture(scenario),good=replay(value),off=scenario===WORKFLOW_SCENARIOS[1],escape=scenario===WORKFLOW_SCENARIOS[3];
  assert.equal(good.status,0,good.stderr);
  assert.deepEqual(JSON.parse(good.stdout),{scenario,transitions:scenario===WORKFLOW_SCENARIOS[0]?4:0,stops:off?1:2,reports:off||escape?0:1,runStatus:off||escape?"running":"done"});
  const mutations=[v=>v.native.code=1,v=>v.native.child=v.native.parent,v=>v.native.failedTurns=1,v=>v.native.childRequests++,v=>v.stops.pop(),v=>v.book.ledger.push({kind:"review-clean"}),v=>v.journal.reservations.push({}),v=>v.journal.reports.push({}),v=>v.stops[0].completions=1];
  if(off)mutations.push(v=>v.baselineHashes[1]=digest("changed"),v=>v.journal.modes[0].sage=true,v=>v.stops[0].decision="completed");
  else mutations.push(v=>v.stops[0].turn="other-turn",v=>v.journal.completions[0]={...v.journal.completions[0],assignment:"other"},v=>v.journal.bindings[0]={...v.journal.bindings[0],issuer:"other"});
  if(escape)mutations.push(v=>v.book.runs[0].status="done",v=>v.results[0].workflow_1="run-finished",v=>v.stops[1].reportHash=digest("changed"));
  if(scenario===WORKFLOW_SCENARIOS[2])mutations.push(v=>v.stops[0].reportHash=v.stops[1].reportHash,v=>v.journal.reports[0].text="changed",v=>v.journal.reports[0].run="R2");
  if(scenario===WORKFLOW_SCENARIOS[0])mutations.push(v=>v.transitions.reverse(),v=>v.journal.taskUpdates.pop(),v=>v.results.at(-1).workflow_15.decision="task-updated",v=>v.results.reverse());
  for(const mutate of mutations){const bad=structuredClone(value);mutate(bad);assert.notEqual(replay(bad).status,0,mutate.toString());}
});

// These assertions target the previously accepted contradictions, not the absent-main selector.
const identityMutations = [
  ["wrong stop child",v=>v.stops[0].child=other],
  ["wrong native child",v=>v.native.child=other],
  ["wrong native parent",v=>v.native.parent=other],
  ["wrong stop session",v=>v.stops[0].session=other],
  ["missing stop turn",v=>delete v.stops[0].turn],
  ["invalid stop turn",v=>v.stops[0].turn=17],
  ["malformed stop turn",v=>v.stops[0].turn="wrong-turn"],
  ["wrong valid stop turn",v=>v.stops[0].turn=other],
  ["wrong transcript parent",v=>v.offIdentity.parent=other],
  ["wrong transcript session",v=>v.offIdentity.session=other],
  ["wrong transcript turn",v=>v.offIdentity.turn=other],
];
for(const [name,mutate] of identityMutations) test(`unmanaged identity refuses ${name}`,()=>{
  const value=fixture(WORKFLOW_SCENARIOS[1]);
  const good=replay(value);assert.equal(good.status,0,good.stderr);
  mutate(value);const bad=replay(value);assert.notEqual(bad.status,0,`accepted contradictory ${name}`);
});
