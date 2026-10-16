import {test} from "node:test";
import assert from "node:assert/strict";
import {observeRestartChild} from "./restart-child.mjs";
test("restart child loading sends no input and normalized interruption is no receipt",async()=>{
 const calls=[],records=[];
 const result=await observeRestartChild(async(...args)=>{calls.push(args);return {thread:{id:"child",turns:[{id:"turn",status:"interrupted"}]}};},"child","turn",(...args)=>records.push(args));
 assert.deepEqual(calls,[["thread/resume",{threadId:"child"}]]);
 assert.equal(result.interruptAttempted,false);assert.equal(result.persistedReceiptRequired,true);
 assert.deepEqual(records.map(row=>row[0]),["child-load-result","child-interrupt-result"]);
});
test("restart child interruption requires exact active turn and records request errors",async()=>{
 const calls=[];
 const result=await observeRestartChild(async(method,args)=>{calls.push([method,args]);if(method==="thread/resume")return {thread:{id:"child",turns:[{id:"turn",status:"inProgress"}]}};throw Error("no active turn to interrupt");},"child","turn",()=>{});
 assert.deepEqual(calls,[["thread/resume",{threadId:"child"}],["turn/interrupt",{threadId:"child",turnId:"turn"}]]);
 assert.equal(result.requestError,"no active turn to interrupt");assert.equal(result.persistedReceiptRequired,true);
 await assert.rejects(observeRestartChild(async()=>({thread:{id:"child",turns:[{id:"other",status:"inProgress"}]}}),"child","turn",()=>{}),/active_turn_changed/);
});

test("restart child interrupt timeout remains an unknown outcome",async()=>{
 const result=await observeRestartChild(async(method)=>{if(method==="thread/resume")return {thread:{id:"child",turns:[{id:"turn",status:"inProgress"}]}};throw Error("child_observation_deadline");},"child","turn",()=>{});
 assert.equal(result.requestError,"child_observation_deadline");assert.equal(result.outcomeUnknown,true);
 assert.equal(Object.hasOwn(result,"refusal"),false);assert.equal(result.persistedReceiptRequired,true);
});
