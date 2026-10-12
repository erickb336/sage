import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,writeFileSync,rmSync,realpathSync,symlinkSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import * as identity from './identity.mjs';

const session='11111111-1111-4111-8111-111111111111';
const turn='22222222-2222-4222-8222-222222222222';
const child='33333333-3333-4333-8333-333333333333';
const other='44444444-4444-4444-8444-444444444444';
const expected={session,actor:session,parent:null,path:'/root',turn,call:'command_1',command:'printf fixed'};
const envelope={cmd:expected.command,shell:'/bin/sh',workdir:'/fixture/project',tty:false,sandbox_permissions:'use_default',max_output_tokens:1000};
const rows=()=>[
 {type:'session_meta',payload:{id:session,session_id:session,cli_version:'0.160.0'}},
 {type:'event_msg',payload:{type:'task_started',turn_id:turn}},
 {type:'turn_context',payload:{turn_id:turn}},
 {type:'response_item',metadata:{client_authored:false},payload:{type:'function_call',name:'exec_command',call_id:expected.call,arguments:JSON.stringify(envelope),internal_chat_message_metadata_passthrough:{turn_id:turn}}},
];
function fixture(t){
 const root=realpathSync(mkdtempSync(join(tmpdir(),'sage-command-reader-'))),path=join(root,'native.jsonl');
 t.after(()=>rmSync(root,{recursive:true,force:true}));
 const save=value=>writeFileSync(path,value.map(row=>JSON.stringify(row)).join('\n')+'\n');
 save(rows());
 return {root,path,save,read:(match=expected)=>identity.readNativeCommand(path,{sessionsDir:root},match)};
}

test('native command evidence preserves the exact root and child envelopes before execution',t=>{
 const f=fixture(t);assert.deepEqual(f.read(),envelope);
 const nested=rows();nested[0].payload={...nested[0].payload,id:child,parent_thread_id:session,agent_path:'/root/lead'};
 f.save(nested);assert.deepEqual(f.read({...expected,actor:child,parent:session,path:'/root/lead'}),envelope);
 // These strings are parser input only. Never run them in a shell.
 const arbitrary={...envelope,cmd:'$(touch forbidden); gh pr merge 1',shell:'custom-shell',new_option:{policyMustCheck:true}};
 nested[3].payload.arguments=JSON.stringify(arbitrary);f.save(nested);
 assert.deepEqual(f.read({...expected,actor:child,parent:session,path:'/root/lead',command:arbitrary.cmd}),arbitrary);
});

test('native command evidence rejects altered identity, duplicate calls and execution results',t=>{
 const f=fixture(t);
 // The positive assertion also makes the missing reader fail the main-branch test.
 assert.deepEqual(f.read(),envelope);
 for(const patch of [{session:other},{actor:other},{turn:other},{call:'wrong'},{command:'different'},{parent:child},{path:'/root/lead'},{extra:true}]){
  assert.throws(()=>f.read({...expected,...patch}),/command evidence is unavailable/);
 }
 const changes=[
  r=>r[0].payload.cli_version='0.159.0',
  r=>r[0].payload.session_id=other,
  r=>r[0].payload.agent_path='/root',
  r=>r[3].metadata.client_authored=true,
  r=>delete r[3].metadata,
  r=>r[3].payload.internal_chat_message_metadata_passthrough.turn_id=other,
  r=>r[3].payload.name='shell_command',
  r=>r[3].payload.namespace='functions',
  r=>r[3].payload.arguments='{}',
  r=>r[3].payload.arguments='null',
  r=>r[3].payload.arguments='{',
  r=>r.push(structuredClone(r[3])),
  r=>r.push({type:'response_item',payload:{type:'function_call_output',call_id:expected.call,output:'done'}}),
  r=>r.push({type:'event_msg',payload:{type:'task_started',turn_id:other}}),
  r=>r.push({type:'event_msg',payload:{type:'task_complete',turn_id:turn}}),
  r=>r.splice(2,1),
  r=>r.push(structuredClone(r[0])),
 ];
 for(const mutate of changes){const value=rows();mutate(value);f.save(value);assert.throws(()=>f.read(),/command evidence is unavailable/);}
});

test('native command evidence refuses linked, incomplete and out-of-root transcripts',t=>{
 const f=fixture(t);assert.deepEqual(f.read(),envelope);
 const link=join(f.root,'linked.jsonl');symlinkSync(f.path,link);
 assert.throws(()=>identity.readNativeCommand(link,{sessionsDir:f.root},expected),/command evidence is unavailable/);
 assert.throws(()=>identity.readNativeCommand(f.path,{sessionsDir:join(f.root,'other')},expected),/command evidence is unavailable/);
 writeFileSync(f.path,JSON.stringify(rows()[0]));assert.throws(()=>f.read(),/command evidence is unavailable/);
 f.save(rows());assert.deepEqual(f.read(),envelope);
});


test('native command evidence refuses interrupted turns for root and child commands', t => {
 const f=fixture(t);
 for(const nested of [false,true]) for(const beforeCall of [false,true]) {
  const value=rows();
  const match=nested?{...expected,actor:child,parent:session,path:'/root/lead'}:expected;
  if(nested)value[0].payload={...value[0].payload,id:child,parent_thread_id:session,agent_path:'/root/lead'};
  f.save(value);assert.deepEqual(f.read(match),envelope);
  value.splice(beforeCall?3:4,0,{type:'event_msg',payload:{type:'turn_aborted',turn_id:turn,reason:'interrupted'}});
  f.save(value);assert.throws(()=>f.read(match),/command evidence is unavailable/);
 }
 // A historical interruption must not refuse a distinct current turn.
 const current=rows();
 current.splice(1,0,{type:'event_msg',payload:{type:'task_started',turn_id:other}},
  {type:'turn_context',payload:{turn_id:other}},
  {type:'event_msg',payload:{type:'turn_aborted',turn_id:other,reason:'interrupted'}});
 f.save(current);assert.deepEqual(f.read(),envelope);
});
