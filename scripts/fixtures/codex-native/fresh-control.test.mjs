import { test } from "node:test";
import assert from "node:assert/strict";
import { freshControlCompletion, capacityChildPhase } from "./fresh-control.mjs";

test("fresh continuation completion requires the actual successful control output", () => {
  const marker="fixed child report";
  assert.equal(freshControlCompletion({resources:[]},marker),marker);
  for(const denied of [undefined,null,"Tool call blocked by PreToolUse hook",{decision:"deny"},
    {resources:[],error:"denied"},{resources:[{uri:"unexpected"}]}]) {
    assert.throws(()=>freshControlCompletion(denied,marker),/fresh_control_not_successful/);
  }
});

test("capacity child routing distinguishes the initial blocked stop from the exact fresh assignment", () => {
  assert.equal(capacityChildPhase({initialPrompt:true,freshPrompt:false,freshDispatched:false}), "initial");
  assert.equal(capacityChildPhase({initialPrompt:false,freshPrompt:true,freshDispatched:true}), "fresh");
  for (const input of [
    {initialPrompt:true,freshPrompt:true,freshDispatched:true},
    {initialPrompt:false,freshPrompt:false,freshDispatched:false},
    {initialPrompt:false,freshPrompt:true,freshDispatched:false},
    {initialPrompt:true,freshPrompt:false,freshDispatched:true},
  ]) assert.throws(() => capacityChildPhase(input));
});
