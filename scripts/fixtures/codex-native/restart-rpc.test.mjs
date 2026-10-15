import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { restartRpc, restartOutcome, trackedVersion } from "./restart-rpc.mjs";
function child(){const c=new EventEmitter();c.stdin=new PassThrough();c.stdout=new PassThrough();c.stderr=new PassThrough();c.signals=[];c.kill=s=>{c.signals.push(s);return true;};return c;}
test("EOF is not exit; pending RPC resolves only by its matching response",async()=>{
 const c=child(),rpc=restartRpc(c);const request=rpc.request("initialize",{});
 c.stdout.write('{"id":1,"result":');c.stdout.write('{"ok":true}}\n');assert.deepEqual(await request,{ok:true});
 rpc.eof();assert.equal(rpc.closed,false);assert.equal(restartOutcome("clean-eof"),"not-terminal");
 c.emit("close",0,null);assert.equal(restartOutcome("clean-eof",await rpc.stopped),"clean-exit");assert.deepEqual(c.signals,[]);
});
test("abrupt loss signals only the supplied handle and still requires terminal evidence",async()=>{
 const c=child(),rpc=restartRpc(c);rpc.abrupt();assert.deepEqual(c.signals,["SIGKILL"]);assert.equal(rpc.closed,false);
 c.emit("close",null,"SIGKILL");assert.equal(restartOutcome("abrupt-loss",await rpc.stopped),"tracked-abrupt-exit");
 assert.equal(restartOutcome("clean-eof",{code:null,signal:"SIGKILL"}),"nonclean-exit");
});
test("RPC close rejects unfinished work and malformed response cannot establish success",async()=>{
 const c=child(),rpc=restartRpc(c),request=rpc.request("thread/resume",{});const rejection=assert.rejects(request,/restart_transport_closed/);
 c.emit("close",1,null);await rejection;
 const d=child(),other=restartRpc(d),bad=other.request("thread/start",{});const invalid=assert.rejects(bad,/JSON/);
 d.stdout.write('not-json\n');await invalid;d.emit("close",1,null);
});
test("restart recorder failure cannot block EOF or tracked signal cleanup",async()=>{
 const first=child(),rpc=restartRpc(first,{record:()=>{throw Error("disk full");}});
 rpc.eof();assert.equal(first.stdin.writableEnded,true);rpc.abrupt();assert.deepEqual(first.signals,["SIGKILL"]);
 first.emit("close",null,"SIGKILL");assert.deepEqual(await rpc.stopped,{code:null,signal:"SIGKILL"});
});

test("restart version owner remains tracked after bounded output failure",async()=>{
 const c=child(),owner=trackedVersion(c,4);c.stdout.write("too long");
 assert.throws(()=>owner.text,/output_bound/);assert.equal(owner.closed,false);
 owner.eof();assert.equal(c.stdin.writableEnded,true);owner.abrupt();assert.deepEqual(c.signals,["SIGKILL"]);
 c.emit("close",null,"SIGKILL");assert.deepEqual(await owner.stopped,{code:null,signal:"SIGKILL"});assert.equal(owner.closed,true);
});
