import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const digest = text => createHash("sha256").update(text).digest("hex");
const original = () => {
  const binding = { assignment:"assignment-one",session:"codex:session-one",child:"child-one",turn:"turn-one" };
  const before = {
    preparations:[{id:"preparation-one",runTarget:{taskBranch:"codex/t1-native"}}],
    reservations:[{assignment:{id:"assignment-one"},preparation:"preparation-one",dispatch:{taskHash:digest("fixed task")}}],
    bindings:[binding],completions:[{...binding}],reports:[],
  };
  return {scenario:"unprepared-followup",before,after:structuredClone(before),
    bookBefore:{tasks:[{id:"T1",branch:"codex/t1-native"}],runs:[{id:"R1",status:"running"}]},
    bookAfter:{tasks:[{id:"T1",branch:"codex/t1-native"}],runs:[{id:"R1",status:"running"}]},
    terminal:{session:"session-one",child:"child-one",turn:"turn-one",taskHash:digest("fixed task"),
      reportMessage:"amsg_fixed_report",text:"fixed terminal report",reportHash:digest("fixed terminal report")},
    denial:"Sage could not verify this tool call.",call:"admission_follow",childRequests:2,
    events:[{hook_event_name:"SubagentStart"},{hook_event_name:"PreToolUse",tool_use_id:"admission_follow",tool_name:"collaborationfollowup_task",session_id:"session-one"}]};
};
const replay = input => spawnSync(process.execPath,[fileURLToPath(new URL("../../probe-codex-lifecycle.mjs",import.meta.url)),"--admission-evidence"],
  {input:JSON.stringify(input),encoding:"utf8",env:{...process.env,NODE_TEST_CONTEXT:""},shell:false});

test("unprepared follow-up evidence preserves the original assignment and rejects contradictory observations", () => {
  const good = replay(original());
  assert.equal(good.status,0,good.stderr);
  assert.deepEqual(JSON.parse(good.stdout),{scenario:"unprepared-followup",preparations:1,reservations:1,bindings:1,completions:1,
    originalTargetPreserved:true,noPostToolUse:true,noExtraChildTurn:true});
  const mutations = [
    input => input.scenario = "retargeted-run",
    input => input.call = "other-call",
    input => input.denial = "accepted",
    input => input.after.preparations.push({id:"extra"}),
    input => input.after.reservations[0].dispatch.taskHash = digest("changed task"),
    input => input.after.bindings[0].turn = "changed-turn",
    input => input.after.completions = [],
    input => input.after.completions[0].assignment = "changed-assignment",
    input => input.after.reports.push({reportHash:digest("unexpected report")}),
    input => input.terminal.session = "other-session",
    input => input.terminal.child = "other-child",
    input => input.terminal.turn = "other-turn",
    input => input.terminal.taskHash = digest("other task"),
    input => input.terminal.text = "different report",
    input => input.terminal.reportMessage = "",
    input => input.events = input.events.filter(row => row.hook_event_name !== "PreToolUse"),
    input => input.events.push({hook_event_name:"PostToolUse",tool_use_id:"admission_follow"}),
    input => input.events.push({hook_event_name:"SubagentStart"}),
    input => input.childRequests = 3,
    input => input.events[1].tool_name = "other-tool",
    input => input.events[1].session_id = "other-session",
    input => input.bookAfter.runs[0].status = "done",
  ];
  for (const [index, mutate] of mutations.entries()) {
    const input=original();mutate(input);
    const rejected=replay(input);
    assert.equal(rejected.status,1,`mutation ${index+1} accepted: ${rejected.stdout}`);
    assert.equal(rejected.stdout,"",`mutation ${index+1} emitted success`);
    assert.match(rejected.stderr,/AssertionError/,`mutation ${index+1} failed outside validation`);
  }
});
