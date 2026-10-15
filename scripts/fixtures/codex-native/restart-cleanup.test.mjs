import { test } from "node:test";
import assert from "node:assert/strict";
import { cleanupRestart } from "./restart-cleanup.mjs";
function handle(broken=false) {
 let finish;const value={closed:false,stopped:new Promise(resolve=>{finish=resolve;}),
 eof(){if(broken)throw Error("broken EOF");value.closed=true;finish({code:0,signal:null});},
 abrupt(){value.closed=true;finish({code:null,signal:"SIGKILL"});}};return value;
}
test("restart cleanup closes every handle and server even when capture and one EOF throw",async()=>{
 const one=handle(true),two=handle();let responsesClosed=false,serverClosed=false,removed=false;
 const result=await cleanupRestart({capture:()=>{throw Error("capture unavailable");},handles:[one,two],
 closeResponses:()=>{responsesClosed=true;},closeServer:()=>{serverClosed=true;},removeRoot:()=>{removed=true;},timeout:1});
 assert.equal(one.closed,true);assert.equal(two.closed,true);assert.equal(result.ownedHandlesClosed,true);
 assert.equal(responsesClosed,true);assert.equal(serverClosed,true);assert.equal(removed,false);
 assert(result.errors.some(row=>row.phase==="capture"&&row.message==="capture unavailable"));
 assert(result.errors.some(row=>row.message==="broken EOF"));
});
test("restart cleanup still closes server after a handle signal fails and keeps failed evidence",async()=>{
 const broken={closed:false,stopped:new Promise(()=>{}),eof(){throw Error("EOF failed");},abrupt(){throw Error("signal failed");}};
 const healthy=handle();let serverClosed=false,removed=false;
 const result=await cleanupRestart({capture:()=>({complete:true,verified:false}),handles:[broken,healthy],
 closeResponses:()=>{throw Error("response failed");},closeServer:()=>{serverClosed=true;},removeRoot:()=>{removed=true;},timeout:1});
 assert.equal(healthy.closed,true);assert.equal(serverClosed,true);assert.equal(removed,false);assert.equal(result.ownedHandlesClosed,false);
 assert(result.errors.some(row=>row.message==="signal failed"));assert.equal(result.evidence.verified,false);
});
