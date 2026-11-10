import './test-env.mjs';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
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
  run('task','add', '--priority', 'P2','--title','Usage test','--size','small');
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
  assert.match(s.run('status'),/usage T1 · 0 measured tokens · partial measured total; 0 measured, 1 unavailable, 1 legacy-unrecorded/);
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
  assert.throws(()=>s.run('status'),/incomplete/);
  // The next writer settles the saved change from its marker alone, then its own command gets its own answer.
  assert.throws(()=>s.run('run','usage','R1','--tokens','51','--usage-source','export','--usage-evidence','pages/R1.json'),/never changes/);
  assert.deepEqual(s.bytes(),after);
  s.run(...command);assert.deepEqual(s.bytes(),after);
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
test('T28 status shows exact per-task measured totals with incomplete accounting',t=>{
  const s=fixture(t);s.run('task','add', '--priority', 'P2','--title','Second','--size','small');
  s.run('run','add','T1','--role','qa');s.run('run','done','R1','--status','done','--tokens','1000');
  s.run('run','add','T2','--role','qa');s.run('run','done','R2','--status','done','--tokens','2400');
  s.run('run','add','T2','--role','qa');s.run('run','done','R3','--status','blocked','--tokens','9000');
  s.run('run','add','T2','--role','qa',...binding);s.run('run','done','R4','--status','done',...unavailable);
  const status=s.run('status');
  assert.match(status,/about 3k tokens · partial measured total; 2 measured, 1 unavailable, 0 legacy-unrecorded/);
  assert.match(status,/^usage T1 · 1000 measured tokens · 1 measured, 0 unavailable, 0 legacy-unrecorded$/m);
  assert.match(status,/^usage T2 · 2400 measured tokens · partial measured total; 1 measured, 1 unavailable, 0 legacy-unrecorded$/m);
});
// T954: no Claude lead run had tokens (41 of 41 in a shared logbook), because the chief ended each with run done --status
// done and no --tokens, and nothing refused it. A lead that gave a report now gives its own tokens, as a review run does.
test('T954 a Claude lead run that ends with a report needs its tokens; a lead with no report ends without them',async t=>{
  const claude=await import('../plugins/sage/skills/sage/sage.mjs');
  const base=realpathSync(mkdtempSync(join(tmpdir(),'sage-usage-lead-')));t.after(()=>rmSync(base,{recursive:true,force:true}));
  const env={...process.env,SAGE_HOME:join(base,'home'),HOME:join(base,'home'),SAGE_TEST_PIDS:'{}'},project=join(base,'project');
  const run=(...args)=>claude.sage([...args,'--project',project],env);
  const dir=run('init').replace(/^logbook /,'');
  run('task','add','--priority','P2','--title','Lead tokens','--size','small');run('task','T1','set','state=briefed');
  const tokens=()=>readFileSync(join(dir,'runs.tsv'),'utf8').trimEnd().split('\n').slice(1).map(line=>line.split('\t')[7]);
  for(const status of ['done','blocked','question']){
    const id=run('run','add','T1','--role','lead').split(' ')[0];
    assert.throws(()=>run('run','done',id,'--status',status),new RegExp(`${id} is a lead run, so run done --status ${status} needs --tokens with the lead's own tokens`),status);
    assert.equal(run('run','done',id,'--status',status,'--tokens','108973'),`${id} ${status}`);
  }
  const failed=run('run','add','T1','--role','lead').split(' ')[0];
  assert.equal(run('run','done',failed,'--status','failed'),`${failed} failed`);
  assert.deepEqual(tokens(),['108973','108973','108973','']);
  assert.match(run('status'),/about 109k tokens · 1 measured, 0 unavailable, 0 legacy-unrecorded/); // the totals count done runs only
});
// T969 (F-T954-2): a Claude lead that ends with a report, but whose notice gave no usage (for example after a restart), could
// end only as failed. It now ends with its status and usage unavailable, with the reason; a lead with no report gets none.
test('T969 a Claude lead with a report and no usage in its notice ends as unavailable, with its reason',async t=>{
  const claude=await import('../plugins/sage/skills/sage/sage.mjs');
  const base=realpathSync(mkdtempSync(join(tmpdir(),'sage-usage-lead-')));t.after(()=>rmSync(base,{recursive:true,force:true}));
  const env={...process.env,SAGE_HOME:join(base,'home'),HOME:join(base,'home'),SAGE_TEST_PIDS:'{}'},project=join(base,'project');
  const run=(...args)=>claude.sage([...args,'--project',project],env);
  const dir=run('init').replace(/^logbook /,'');
  run('task','add','--priority','P2','--title','Lead tokens','--size','small');run('task','T1','set','state=briefed');
  const rows=()=>{const [head,...lines]=readFileSync(join(dir,'runs.tsv'),'utf8').trimEnd().split('\n');return lines.map(line=>Object.fromEntries(head.split('\t').map((k,i)=>[k,line.split('\t')[i]??''])));};
  const why=['--usage','unavailable','--usage-source','claude task notice','--usage-evidence','the notice had no usage after a restart','--report','pages/lead.md'];
  const ids=[];
  for(const status of ['done','blocked','question']){
    const id=run('run','add','T1','--role','lead').split(' ')[0];ids.push(id);
    assert.throws(()=>run('run','done',id,'--status',status),/When its usage gave no count, add --usage unavailable with --usage-source, --usage-evidence \(the reason\) and --report/);
    assert.throws(()=>run('run','done',id,'--status',status,...why.slice(0,-2)),/Unavailable usage needs/,'a report is needed');
    assert.equal(run('run','done',id,'--status',status,...why),`${id} ${status}`);
  }
  // A lead with no report ends as failed, with no usage claim; and a review run still needs its tokens.
  const failed=run('run','add','T1','--role','lead').split(' ')[0];
  assert.throws(()=>run('run','done',failed,'--status','failed',...why),/Unavailable usage needs/);
  const qa=run('run','add','T1','--role','qa').split(' ')[0];
  assert.throws(()=>run('run','done',qa,'--status','done',...why),/Unavailable usage needs/);
  assert.deepEqual(rows().filter(r=>ids.includes(r.id)).map(r=>[r.status,r.tokens,r.usage_status,r.usage_source,r.usage_evidence,r.report]),
    ['done','blocked','question'].map(status=>[status,'','unavailable','claude task notice','the notice had no usage after a restart','pages/lead.md']));
  assert.match(run('status'),/partial measured total; 0 measured, 1 unavailable, 0 legacy-unrecorded/); // the totals count done runs only
});
