import { test } from "node:test";
import assert from "node:assert/strict";
import { freshControlCompletion } from "./fresh-control.mjs";

test("fresh continuation completion requires the actual successful control output", () => {
  const marker="fixed child report";
  assert.equal(freshControlCompletion({resources:[]},marker),marker);
  for(const denied of [undefined,null,"Tool call blocked by PreToolUse hook",{decision:"deny"},
    {resources:[],error:"denied"},{resources:[{uri:"unexpected"}]}]) {
    assert.throws(()=>freshControlCompletion(denied,marker),/fresh_control_not_successful/);
  }
});
