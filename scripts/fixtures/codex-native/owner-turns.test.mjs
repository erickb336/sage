import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { assertOwnerTurn, assertOwnerHistory, trackOwnerProcess } from "./owner-turns.mjs";
import { cleanupRestart } from "./restart-cleanup.mjs";

const events = () => [{type:"thread.started",thread_id:"owner"},
  {type:"item.completed",item:{type:"agent_message",text:"owner-turn-0-ok"}}, {type:"turn.completed"}];
const history = () => ({requests:4,deliveries:[[0,0],[1,1],[1,1],[2,2]],session:"owner",
  states:Array.from({length:4},(_,i)=>({sessions:i?[{session:"codex:owner",epoch:"one"}]:[],
    modes:[true,false,true].slice(0,i).map((sage,j)=>({sage,turn:`turn-${j}`})),reservations:[]})),
  initialLogbook:{tasks:[{id:"T1"}],runs:[{id:"R1"}]},finalLogbook:{tasks:[{id:"T1"}],runs:[{id:"R1"}]}});

test("owner turns accept fixed completion and cumulative retained guidance",()=>{
  assert.equal(assertOwnerTurn(events(),0),"owner");
  assertOwnerHistory(history());
});
for(const [name,mutate] of [
  ["unexpected tool",rows=>rows.push({type:"item.started",item:{type:"command_execution"}})],
  ["extra message",rows=>rows.push(rows[1])],
  ["missing completion",rows=>rows.pop()],
  ["failed turn",rows=>rows.push({type:"turn.failed"})]
]) test(`owner turns refuse ${name}`,()=>{const rows=events();mutate(rows);assert.throws(()=>assertOwnerTurn(rows,0));});
test("owner turns refuse a changed resumed session",()=>assert.throws(()=>assertOwnerTurn(events(),0,"other"),/resume_changed_session/));
for(const [name,mutate] of [
  ["extra request",data=>data.requests++],
  ["off injection",data=>data.deliveries[2]=[2,2]],
  ["missing second instruction",data=>data.deliveries[1]=[1,0]],
  ["early owner",data=>data.states[0].sessions=[{session:"codex:owner",epoch:"one"}]],
  ["changed epoch",data=>data.states[3].sessions[0].epoch="two"],
  ["reused turn",data=>data.states[3].modes[2].turn="turn-0"],
  ["ordinary reservation",data=>data.states[0].reservations.push({})],
  ["logbook write",data=>data.finalLogbook.tasks[0].title="changed"]
]) test(`owner history refuses ${name}`,()=>{const data=history();mutate(data);assert.throws(()=>assertOwnerHistory(data));});

test("owner cleanup observes close rather than exit and preserves failed capture",async()=>{
  const child=new EventEmitter();
  child.stdin=new PassThrough();child.stdout=new PassThrough();child.stderr=new PassThrough();
  child.kill=()=>{throw Error("unexpected signal");};
  const handle=trackOwnerProcess(child);
  child.emit("exit",0,null);assert.equal(handle.closed,false);
  child.stdin.on("finish",()=>child.emit("close",0,null));
  let responses=false,server=false,removed=false;
  const result=await cleanupRestart({handles:[handle],capture:()=>{throw Error("capture failed");},
    closeResponses:()=>{responses=true;},closeServer:()=>{server=true;},removeRoot:()=>{removed=true;}});
  assert.equal((await handle.stopped).code,0);assert.equal(handle.closed,true);
  assert.equal(responses,true);assert.equal(server,true);assert.equal(removed,false);
  assert.equal(result.complete,false);assert.equal(result.ownedHandlesClosed,true);
});
