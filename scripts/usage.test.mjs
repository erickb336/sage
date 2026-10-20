import './test-env.mjs';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { mkdtempSync, realpathSync, readFileSync, readdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { tool } from '../plugins/sage-codex/skills/sage/sage.mjs';
function fixture(t) {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'sage-usage-')));
  t.after(() => rmSync(base, {recursive:true, force:true}));
  const env = {...process.env, SAGE_HOME: join(base, 'home'), SAGE_TEST_PIDS:'{}'};
  const project = join(base, 'project');
  const run = (...args) => tool.sage([...args, '--project', project], env);
  const dir = run('init').replace(/^logbook /, '');
  run('task','add','--title','Usage test','--size','small');
  const bytes = () => ['runs','decisions'].map(table => readFileSync(join(dir, table+'.tsv'),'utf8'));
  const rows = () => {
    const [head,...lines] = bytes()[0].trimEnd().split('\n');
    return lines.map(line => Object.fromEntries(head.split('\t').map((k,i)=>[k,line.split('\t')[i] ?? ''])));
  };
  const no = (...args) => { const before=bytes(); assert.throws(()=>run(...args)); assert.deepEqual(bytes(),before); };
  return {run,dir,rows,no,bytes};
}
const binding = ['--usage-interface','collaboration-tools'];
const unavailable = ['--usage','unavailable','--usage-source','tool-schema-v1','--usage-evidence','pages/R1-schema.json','--report','pages/R1-report.md'];
test('T28 unavailable completion preserves declared binding and supports audited enrichment',t=>{
  const s=fixture(t);
  s.run('run','add','T1','--role','qa',...binding);
  assert.equal(s.rows()[0].usage_binding,'chief-declared-unauthenticated');
  assert.equal(s.rows()[0].usage_capability,'unavailable');
  s.run('run','done','R1','--status','done',...unavailable);
  const ended=s.rows()[0];
  assert.equal(ended.tokens,''); assert.equal(ended.usage_status,'unavailable');
  assert.match(s.run('stats'),/partial measured total; 0 measured, 1 unavailable, 0 legacy-unrecorded/);
  assert.match(s.run('status'),/partial measured total; 0 measured, 1 unavailable, 0 legacy-unrecorded/);
  s.no('run','done','R1','--status','done','--tokens','40');
  s.no('run','done','R1','--status','blocked','--tokens','40');
  const enrich=['run','usage','R1','--tokens','40','--usage-source','host-export','--usage-evidence','pages/R1-usage.json'];
  s.run(...enrich);
  const after=s.rows()[0];
  assert.equal(after.tokens,'40'); assert.equal(after.usage_status,'measured');
  for(const field of ['status','report','ended','usage_provider','usage_interface','usage_capability','usage_binding','usage_reason','usage_basis']) assert.equal(after[field],ended[field],field);
  const bytes=s.bytes(); s.run(...enrich); assert.deepEqual(s.bytes(),bytes);
  assert.equal(s.bytes()[1].split('\n').filter(x=>x.includes('R1 usage measured')).length,1);
  for(const tokens of ['41','0','01','-1','1.5','1000000000000']) s.no('run','usage','R1','--tokens',tokens,'--usage-source','host-export','--usage-evidence','pages/R1-usage.json');
  s.no('run','usage','R1','--tokens','40','--usage-source','other','--usage-evidence','pages/R1-usage.json');
  assert.doesNotMatch(s.run('stats'),/partial measured total/);
});
test('T28 supported, default and unknown interfaces cannot select unavailable',t=>{
  const s=fixture(t);
  s.run('run','add','T1','--role','qa');
  s.run('run','done','R1','--status','done','--tokens','8'); // baseline-positive setup
  for (const iface of ['made-up','', 'constructor']) s.no('run','add','T1','--role','qa','--usage-interface',iface);
  s.run('run','add','T1','--role','qa','--usage-interface','app-server');
  s.no('run','done','R2','--status','done',...unavailable);
  s.no('run','done','R2','--status','done');
  s.no('run','done','R2','--status','done','--tokens','12');
  s.run('run','done','R2','--status','done','--tokens','12','--usage-source','native-event','--usage-evidence','pages/R2.json');
  s.run('run','add','T1','--role','qa');
  s.no('run','done','R3','--status','done',...unavailable);
  s.no('run','add','T1','--role','qa',...binding,'--usage-capability','unavailable');
});
test('T28 malformed unavailable evidence refuses without writes',t=>{
  const s=fixture(t);
  s.run('run','add','T1','--role','qa',...binding);
  const args=['run','done','R1','--status','done',...unavailable];
  for(const field of ['--report','--usage-source','--usage-evidence']) {
    for(const value of ['', ' ', 'x\ty','x\ny','x\ufe00y','a'.repeat(2049)]) { const a=[...args];a[a.indexOf(field)+1]=value;s.no(...a); }
    const a=[...args];a.splice(a.indexOf(field),2);s.no(...a);
  }
  s.no(...args,'--tokens','6');
  s.no(...args.slice(0,4),'blocked',...unavailable);
  s.run(...args);
});
test('T28 mixed legacy accounting and blocked enrichment preserve terminal facts',t=>{
  const s=fixture(t);
  s.run('run','add','T1','--role','qa');s.run('run','done','R1','--status','blocked','--report','pages/blocked.md');
  const before=s.rows()[0];
  s.run('run','usage','R1','--tokens','5','--usage-source','host-export','--usage-evidence','pages/R1.json');
  for(const f of ['status','report','ended']) assert.equal(s.rows()[0][f],before[f]);
  s.no('run','done','R1','--status','done','--tokens','5');
  s.run('run','add','T1','--role','qa');s.run('run','done','R2','--status','done','--tokens','7');
  s.run('run','add','T1','--role','qa',...binding);s.run('run','done','R3','--status','done',...unavailable);
  // A pre-usage logbook can contain a completed run without tokens.
  const file=join(s.dir,'runs.tsv'),[head,...lines]=readFileSync(file,'utf8').trimEnd().split('\n');
  const keys=head.split('\t'),cells=lines[1].split('\t');cells[keys.indexOf('tokens')]='';cells[keys.indexOf('usage_status')]='';lines[1]=cells.join('\t');writeFileSync(file,[head,...lines].join('\n')+'\n');
  assert.match(s.run('stats'),/usage total · partial measured total; 0 measured, 1 unavailable, 1 legacy-unrecorded/);
  assert.match(s.run('status'),/usage T1 · partial measured total; 0 measured, 1 unavailable, 1 legacy-unrecorded/);
});

test('T28 declared capability snapshot survives provider registry changes',async t=>{
  const s=fixture(t);
  s.run('run','add','T1','--role','qa',...binding);
  const before=s.rows()[0];
  const {createStateTool}=await import('../plugins/sage-codex/core/index.mjs');
  const changed=createStateTool({defaultRoot:()=>join(s.dir,'unused'),usageInterfaces:[]});
  // SAGE_HOME is the same root used by the fixture. No registry reclassification occurs at completion.
  const root=join(s.dir,'..');
  changed.sage(['run','done','R1','--status','done',...unavailable,'--project',join(root,'..','project')],{...process.env,SAGE_HOME:root,SAGE_TEST_PIDS:'{}'});
  assert.equal(s.rows()[0].usage_reason,before.usage_reason);
  assert.equal(s.rows()[0].usage_capability,'unavailable');
});

function envelope(value) { return JSON.stringify({value,hash:createHash('sha256').update(JSON.stringify(value)).digest('hex')})+'\n'; }
test('T28 usage recovery completes one interrupted transaction and refuses a different retry', t=>{
  const s=fixture(t);s.run('run','add','T1','--role','qa',...binding);s.run('run','done','R1','--status','done',...unavailable);
  const before=s.bytes();
  const command=['run','usage','R1','--tokens','50','--usage-source','export','--usage-evidence','pages/R1.json'];s.run(...command);
  const after=s.bytes(),folder=join(s.dir,'usage-requests');
  const receipt=JSON.parse(readFileSync(join(folder,readdirSync(folder)[0]),'utf8')).value;
  const tables=Object.fromEntries(['runs','decisions'].map((table,i)=>[table,{before:before[i],after:after[i]}]));
  // Simulate a crash after runs publishes, before decisions publishes.
  writeFileSync(join(s.dir,'decisions.tsv'),before[1]);
  writeFileSync(join(s.dir,'review-pending.json'),envelope({schema:7,receipt,tables}));
  s.no('run','usage','R1','--tokens','51','--usage-source','export','--usage-evidence','pages/R1.json');
  assert.throws(()=>s.run('status'),/incomplete|damaged/);
  s.run(...command);assert.deepEqual(s.bytes(),after);
  s.run(...command);assert.deepEqual(s.bytes(),after);
});
test('T28 old run-request pending bytes recover with their original header',t=>{
  const s=fixture(t),before=s.bytes()[0];
  const input={project:join(s.dir,'..','..','project'),owner:'test-owner',request:randomUUID(),task:'T1',role:'qa',branch:'',candidate:''};
  const env={...process.env,SAGE_HOME:join(s.dir,'..'),SAGE_TEST_PIDS:'{}'};
  tool.createRequestedRun(input,env);
  const folder=join(s.dir,'run-requests'),receipt=JSON.parse(readFileSync(join(folder,readdirSync(folder)[0]),'utf8')).value;
  const old=text=>text.split('\n').filter(Boolean).map(line=>line.split('\t').slice(0,12).join('\t')).join('\n')+'\n';
  const oldBefore=old(before), oldAfter=old(s.bytes()[0]);
  writeFileSync(join(s.dir,'runs.tsv'),oldBefore);
  writeFileSync(join(s.dir,'review-pending.json'),envelope({schema:3,receipt,tables:{runs:{before:oldBefore,after:oldAfter}}}));
  const result=tool.createRequestedRun(input,env);assert.equal(result.decision,'run-created');assert.equal(result.run.id,'R1');
  assert.equal(readFileSync(join(s.dir,'runs.tsv'),'utf8'),oldAfter);
  assert.equal(tool.createRequestedRun(input,env).decision,'already-created');
  s.no('run','done','R1','--status','done',...unavailable);
});

test('T28 schema-less usage columns migrate without inventing availability',t=>{
  const s=fixture(t);s.run('run','add','T1','--role','qa');
  const file=join(s.dir,'runs.tsv');
  writeFileSync(file,readFileSync(file,'utf8').split('\n').filter(Boolean).map(line=>line.split('\t').slice(0,12).join('\t')).join('\n')+'\n');
  s.no('run','done','R1','--status','done',...unavailable);
  s.run('run','done','R1','--status','done','--tokens','9');
  assert.equal(s.rows()[0].usage_provider,'');assert.equal(s.rows()[0].usage_status,'measured');assert.equal(s.rows()[0].tokens,'9');
  assert.match(s.run('stats'),/1 measured, 0 unavailable, 0 legacy-unrecorded/);
});
test('T28 other provider cannot select the Codex registry',async t=>{
  const s=fixture(t);const other=await import('../plugins/sage/skills/sage/sage.mjs');
  const before=s.bytes();assert.throws(()=>other.sage(['run','add','T1','--role','qa',...binding,'--project',join(s.dir,'..','..','project')],{...process.env,SAGE_HOME:join(s.dir,'..'),SAGE_TEST_PIDS:'{}'}),/Unknown usage interface/);assert.deepEqual(s.bytes(),before);
});
