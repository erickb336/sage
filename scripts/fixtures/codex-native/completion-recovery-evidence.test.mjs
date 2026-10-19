import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
const diagnostic=fileURLToPath(new URL('../../probe-codex-lifecycle.mjs',import.meta.url));
const replay=input=>spawnSync(process.execPath,[diagnostic,'--completion-recovery-evidence'],{input:JSON.stringify(input),encoding:'utf8',env:{...process.env,NODE_TEST_CONTEXT:undefined}});

// Sample records model independent inputs to the diagnostic validator. Actual
// native provenance is checked by readNativeCompletion during the native probe.
function sample({omitStop=false,secondNoTool=true}={}) {
  const bindings=['first','second'].map((assignment,index)=>({assignment,session:'codex:parent',child:'child',turn:`turn-${index}`}));
  const native=bindings.map((bound,index)=>({child:'child',session:'parent',turn:bound.turn,taskHash:`task-${index}`,reportMessage:`message-${index}`,text:`report ${index}`,reportHash:createHash('sha256').update(`report ${index}`).digest('hex')}));
  return {child:'child',session:'parent',omitStop,secondNoTool,
    state:{bindings,completions:structuredClone(bindings),reservations:bindings.map((bound,index)=>({assignment:{id:bound.assignment,task:'T1',run:`R${index+1}`},dispatch:{taskHash:`task-${index}`},...(index ? {continuation:'first'} : {})})),reports:bindings.map((binding,index)=>({binding,text:native[index].text,reportHash:native[index].reportHash,reportMessage:native[index].reportMessage}))},native,
    receipts:bindings.map((bound,index)=>({...bound,decision:'report-recorded',task:'T1',run:`R${index+1}`,reportHash:native[index].reportHash,reportMessage:native[index].reportMessage})),
    callbacks:omitStop?[]:[{decision:'stop-observed',completions:0},{decision:'stop-observed',completions:1}],
    observations:omitStop?[]:bindings.map(bound=>({kind:'child-stop',child:'child',turn:bound.turn})),
    events:secondNoTool?[]:[{hook_event_name:'PreToolUse',turn_id:'turn-1',tool_name:'list_mcp_resources'}]};
}
const cases=[
  ['wrong assignment',x=>x.state.completions[1].assignment='first'],
  ['wrong child',x=>x.native[1].child='other'],
  ['wrong turn',x=>x.native[1].turn='turn-0'],
  ['wrong session',x=>x.native[1].session='other'],
  ['missing native completion',x=>x.native.pop()],
  ['wrong delivery hash',x=>x.native[1].taskHash='task-0'],
  ['missing terminal message',x=>delete x.native[1].reportMessage],
  ['changed final text',x=>x.native[1].text='changed'],
  ['confused receipt assignment',x=>x.receipts[1].assignment='first'],
  ['confused receipt run',x=>x.receipts[1].run='R1'],
  ['reused report',x=>x.receipts[1].reportMessage='message-0'],
  ['wrong continuation',x=>x.state.reservations[1].continuation='other'],
  ['unexpected callback',x=>{x.omitStop=!x.omitStop;}],
  ['wrong callback count',x=>{x.callbacks=[{}];}],
  ['wrong stored callback',x=>x.observations.length ? x.observations[1].turn='turn-0' : x.observations.push({kind:'child-stop',child:'other',turn:'turn-0'})],
  ['unexpected second-turn tool',x=>x.events.push({hook_event_name:'PreToolUse',turn_id:'turn-1',tool_name:'list_mcp_resources'})],
  ['wrong saved report',x=>x.state.reports[1].text='report 0'],
];
for(const options of [{omitStop:true,secondNoTool:false},{omitStop:false,secondNoTool:true},{omitStop:true,secondNoTool:true}]) {
  test(`replay native completion diagnostic ${JSON.stringify(options)}`,()=>{
    const valid=replay(sample(options));
    assert.equal(valid.status,0,valid.stderr);
    assert.deepEqual(JSON.parse(valid.stdout),{assignments:2,nativeCompletions:2,receipts:2,callbacks:options.omitStop?0:2,secondTurnTools:options.secondNoTool?0:1});
    let rejected=0;
    for(const [name,mutate] of cases) {
      const input=sample(options);mutate(input);
      const invalid=replay(input);
      assert.equal(invalid.status,1,name);
      assert.match(invalid.stderr,/AssertionError/,name);
      assert.equal(invalid.stdout,'',name);
      rejected++;
    }
    assert.equal(rejected,17);
  });
}
