import '../../../scripts/test-env.mjs';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { execFileSync, spawnSync } from 'node:child_process';
import { appendFileSync, cpSync, mkdtempSync, mkdirSync, realpathSync, writeFileSync, rmSync, readFileSync, chmodSync, readdirSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tool } from '../../../plugins/sage-codex/skills/sage/sage.mjs';
import { workflow } from '../../../plugins/sage-codex/skills/sage/workflow.mjs';
const cli = fileURLToPath(new URL('../../../plugins/sage-codex/skills/sage/workflow.mjs', import.meta.url));
const mergedSha = 'c'.repeat(40);
function fixture(t, { cycles = 2 } = {}) {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'sage-workflow-')));
  t.after(() => rmSync(base, { recursive: true, force: true }));
  const project = join(base, 'project'); mkdirSync(project);
  const env = { ...process.env, SAGE_HOME: join(base, 'home'), SAGE_TEST_PIDS: '{}' };
  const git = (...args) => execFileSync('git', ['-C', project, ...args], { env, encoding: 'utf8', stdio: ['ignore','pipe','pipe'] }).trim();
  git('init', '-b', 'codex/t1-example');
  git('-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '--allow-empty', '-m', 'Fixture');
  git('remote', 'add', 'origin', 'https://github.com/example/project.git');
  const head = git('rev-parse', 'HEAD');
  const core = (...args) => tool.sage([...args, '--project', project], env);
  core('init'); core('task','add', '--priority', 'P2','--title','Publisher fixture','--size','small','--risk','auth');
  core('task','T1','set','branch=codex/t1-example','pr=7','state=briefed');
  core('task','T1','set','state=building');
  let nextRun = 0;
  const doneRun = role => {
    core('run','add','T1','--role',role,'--usage-interface','collaboration-tools');
    const id = `R${++nextRun}`;
    core('run','done',id,'--status','done','--tokens','1','--usage-source','fixture','--usage-evidence','fixture.json','--report','fixture-report.md');
    return id;
  };
  doneRun('lead');
  core('task','T1','set','state=reviewing');
  core('verdict','T1','--sha',head,'--kind','checks-pass','--pr','7');
  for (let cycle = 1; cycle <= cycles; cycle++) for (const [role, kind] of [['code-reviewer','review-clean'],['security-reviewer','security-clean'],['qa','qa-pass']]) {
    const id = doneRun(role);
    core('verdict','T1','--sha',head,'--kind',kind,'--cycle',String(cycle),'--run',id,'--pr','7');
  }
  core('task','T1','set','state=verifying'); core('task','T1','set','state=verified');
  const evidence = join(base, 'evidence.md'); writeFileSync(evidence,'SIMULATED fixture evidence: checks passed and direct owner message.\n');
  let pr = { number:7, state:'open', draft:false, merged:false, mergeable:true, mergeable_state:'clean',
    head:{sha:head,ref:'codex/t1-example',repo:{full_name:'example/project'}}, base:{ref:'main',repo:{full_name:'example/project'}} };
  let puts = 0, checkConclusion = 'success', uncertain = false;
  const github = args => {
    assert.deepEqual(args.slice(0,3), ['api','--hostname','github.com']);
    const endpoint = args[3];
    if (args.includes('PUT')) {
      assert.deepEqual(args, ['api','--hostname','github.com','repos/example/project/pulls/7/merge','--method','PUT','-f',`sha=${head}`,'-f','merge_method=squash']);
      puts++;
      if (uncertain) throw Error('Simulated lost response');
      pr = {...pr, merged:true, state:'closed', merge_commit_sha:mergedSha};
      return { merged:true, sha:mergedSha };
    }
    if(endpoint.includes('/check-runs?')) return {total_count:1,check_runs:[{head_sha:head,status:'completed',conclusion:checkConclusion}]};
    if(endpoint.includes('/status?')) return {total_count:0,statuses:[],state:'pending'};
    assert.equal(endpoint,'repos/example/project/pulls/7'); return structuredClone(pr);
  };
  const invoke = (action, fields = {}, session='session-one') => workflow({action,project,session,...fields},{env,github});
  const owner = text => invoke('owner',{text,directOwner:true,evidence});
  const enable = () => {owner('sage mode on');owner('autopilot on');invoke('register',{task:'T1',repo:'example/project',base:'main',admissionJournals:[],manualConfirmed:true,noKnownNativeAssignment:true});};
  return {project,env,head,git,core,invoke,owner,enable,evidence,puts:()=>puts,pr:()=>pr,setPr:value=>pr=value,
    failChecks:()=>checkConclusion='failure',loseResponse:()=>uncertain=true,dir:tool.storeDir(project,env)};
}
test('workflow CLI persists owner modes per project and session',t=>{
  const f=fixture(t);
  const call=(action,extra={},session='cli-session')=>JSON.parse(execFileSync(process.execPath,[cli],{env:f.env,input:JSON.stringify({action,project:f.project,session,...extra}),encoding:'utf8'}));
  assert.equal(call('status').sage,false);
  assert.equal(call('owner',{text:'sage mode on',directOwner:true,evidence:f.evidence}).sage,true);
  assert.equal(call('status').publisherVerified,true);
  assert.equal(call('owner',{text:'Autopilot on.',directOwner:true,evidence:f.evidence}).autopilot,true);
  assert.equal(call('status',{},'new-session').autopilot,false);
  assert.equal(call('owner',{text:'autopilot off',directOwner:true,evidence:f.evidence}).sage,true);
  const stopped=call('owner',{text:'sage mode off',directOwner:true,evidence:f.evidence});
  assert.equal(stopped.sage,false);assert.equal(stopped.autopilot,false);
});
test('eligible manual publication persists the merge and updates the core task',t=>{
  const f=fixture(t);f.enable();
  const out=f.invoke('publish',{task:'T1',sha:f.head});
  assert.equal(out.publication.outcome,'merged');assert.equal(out.publication.mergeCommit,mergedSha);assert.equal(out.localState,'merged');
  assert.equal(tool.read(f.dir,'tasks')[0].state,'merged');
  assert.equal(f.invoke('status').publications.T1.outcome,'merged');assert.equal(f.puts(),1);
  assert.throws(()=>f.invoke('publish',{task:'T1',sha:f.head}),/already exists/);assert.equal(f.puts(),1);
});
test('off, changed head, missing cycles, checks and active or ambiguous runs refuse',t=>{
  const f=fixture(t);f.enable();f.owner('autopilot off');
  assert.throws(()=>f.invoke('publish',{task:'T1',sha:f.head}),/active autopilot/);f.owner('autopilot on');
  const pr=f.pr();f.setPr({...pr,head:{...pr.head,sha:'b'.repeat(40)}});
  assert.throws(()=>f.invoke('publish',{task:'T1',sha:f.head}),/identity or head changed/);f.setPr(pr);
  f.failChecks();assert.throws(()=>f.invoke('publish',{task:'T1',sha:f.head}),/All live checks/);
  f.core('run','add','T1','--role','qa','--usage-interface','collaboration-tools');
  assert.throws(()=>f.invoke('publish',{task:'T1',sha:f.head}),/ownership is active/);
  f.core('run','done','R8','--status','blocked','--report','fixture-stop.md');
  f.core('run','add','T1','--role','qa');
  assert.throws(()=>f.invoke('publish',{task:'T1',sha:f.head}),/Native or ambiguous/);
  assert.equal(f.puts(),0);
  const missing=fixture(t,{cycles:1});missing.enable();
  assert.throws(()=>missing.invoke('publish',{task:'T1',sha:missing.head}),/1 of 2 clean cycles/);assert.equal(missing.puts(),0);
});
test('uncertain submission remains fenced and reconciles while off without another PUT',t=>{
  const f=fixture(t);f.enable();f.loseResponse();
  const out=f.invoke('publish',{task:'T1',sha:f.head});assert.equal(out.publication.outcome,'unresolved');
  assert.equal(JSON.parse(readFileSync(join(f.dir,'codex-workflow.json'),'utf8')).publications.T1.outcome,'unresolved');
  assert.throws(()=>f.invoke('publish',{task:'T1',sha:f.head}),/already exists/);
  assert.equal(f.invoke('reconcile',{task:'T1'}).publication.outcome,'unresolved');assert.equal(f.puts(),1);
  f.owner('sage mode off');f.setPr({...f.pr(),merged:true,state:'closed',merge_commit_sha:mergedSha});
  const reconciled=f.invoke('reconcile',{task:'T1'});assert.equal(reconciled.publication.outcome,'merged');assert.equal(reconciled.localState,'merged');
  assert.equal(f.invoke('status').sage,false);assert.equal(f.puts(),1);
});

test('publish CLI emits one JSON result with a fake GitHub executable',t=>{
  const f=fixture(t);f.enable();
  const bin=join(f.project,'fake-bin');mkdirSync(bin);
  const state=join(bin,'state.json');writeFileSync(state,JSON.stringify({pr:f.pr(),puts:0}));
  const gh=join(bin,'gh');
  writeFileSync(gh,`#!/usr/bin/env node
const fs=require('node:fs');const file=process.env.SAGE_WORKFLOW_FAKE_STATE;
const state=JSON.parse(fs.readFileSync(file,'utf8'));const args=process.argv.slice(2);const endpoint=args[3];let out;
if(args.includes('PUT')) {state.puts++;state.pr={...state.pr,merged:true,state:'closed',merge_commit_sha:'${mergedSha}'};out={merged:true,sha:'${mergedSha}'};fs.writeFileSync(file,JSON.stringify(state));}
else if(endpoint.includes('/check-runs?')) out={total_count:1,check_runs:[{head_sha:state.pr.head.sha,status:'completed',conclusion:'success'}]};
else if(endpoint.includes('/status?')) out={total_count:0,statuses:[],state:'pending'};
else out=state.pr;
process.stdout.write(JSON.stringify(out));
`);chmodSync(gh,0o700);
  const output=execFileSync(process.execPath,[cli],{env:{...f.env,PATH:bin+':'+f.env.PATH,SAGE_WORKFLOW_FAKE_STATE:state},
    input:JSON.stringify({action:'publish',project:f.project,session:'session-one',task:'T1',sha:f.head}),encoding:'utf8'});
  const result=JSON.parse(output);assert.equal(result.publication.outcome,'merged');assert.equal(result.localState,'merged');
  assert.equal(JSON.parse(readFileSync(state,'utf8')).puts,1);
});

test('reconciliation records the external outcome but refuses a later native or ambiguous task owner',t=>{
  const f=fixture(t);f.enable();f.loseResponse();f.invoke('publish',{task:'T1',sha:f.head});
  f.core('run','add','T1','--role','qa');
  f.setPr({...f.pr(),merged:true,state:'closed',merge_commit_sha:mergedSha});
  const result=f.invoke('reconcile',{task:'T1'});
  assert.equal(result.publication.outcome,'merged');assert.equal(result.localState,'unresolved');
  assert.match(result.localError,/Native or ambiguous/);assert.equal(tool.read(f.dir,'tasks')[0].state,'verified');assert.equal(f.puts(),1);
});

test('an unanswered task gate refuses before submission and its answer permits publication',t=>{
  const f=fixture(t);f.enable();
  f.core('gate','add','T1','--question','May this task publish?','--options','Approve|Hold','--recommend','Hold');
  assert.throws(()=>f.invoke('publish',{task:'T1',sha:f.head}),/T1 has unanswered gate G1/);
  assert.equal(f.puts(),0);assert.equal(f.invoke('status').publications.T1,undefined);
  f.core('gate','answer','G1','--option','1');
  assert.equal(f.invoke('publish',{task:'T1',sha:f.head}).publication.outcome,'merged');assert.equal(f.puts(),1);
});

function freshStatusFixture(t) {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'sage-fresh-status-')));
  t.after(() => rmSync(base, { recursive: true, force: true }));
  const project = join(base, 'project'); mkdirSync(project);
  const env = { ...process.env, SAGE_HOME: join(base, 'home'), SAGE_TEST_PIDS: '{}' };
  const evidence = join(base, 'owner.md'); writeFileSync(evidence, 'SIMULATED direct owner instruction.');
  const call = (action, extra = {}) => spawnSync(process.execPath, [cli], { env, encoding: 'utf8',
    input: JSON.stringify({ action, project, session: 'fresh-session', ...extra }) });
  const snapshot = () => readdirSync(base, { recursive: true }).sort();
  return { base, project, env, evidence, call, snapshot, dir: tool.storeDir(project, env) };
}
test('T36 fresh status succeeds without creating a missing Sage root or project logbook',t=>{
  for (const existingRoot of [false, true]) {
    const f = freshStatusFixture(t);
    if (existingRoot) mkdirSync(f.env.SAGE_HOME);
    const before = f.snapshot();
    const result = f.call('status');
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout), { project: f.project, session: 'fresh-session',
      sage: false, autopilot: false, publisherVerified: true, publications: {} });
    assert.deepEqual(f.snapshot(), before);
    const mutation = f.call('owner', { text: 'sage mode on', directOwner: true, evidence: f.evidence });
    assert.equal(mutation.status, 1); assert.match(mutation.stderr, /ENOENT/);
    assert.deepEqual(f.snapshot(), before);
  }
});
test('T36 fresh status preserves invalid storage errors without writes',t=>{
  for (const kind of ['root-file', 'dangling-root', 'dangling-logbook', 'malformed-state']) {
    const f = freshStatusFixture(t);
    if (kind === 'root-file') writeFileSync(f.env.SAGE_HOME, 'not a directory');
    else if (kind === 'dangling-root') symlinkSync(join(f.base, 'missing'), f.env.SAGE_HOME);
    else {
      mkdirSync(f.env.SAGE_HOME);
      if (kind === 'dangling-logbook') symlinkSync(join(f.base, 'missing'), f.dir);
      else { mkdirSync(f.dir); writeFileSync(join(f.dir, 'codex-workflow.json'), 'malformed JSON'); }
    }
    const before = f.snapshot();
    const result = f.call('status');
    assert.equal(result.status, 1, kind); assert.equal(result.stdout, '');
    assert.match(result.stderr, kind === 'malformed-state' ? /JSON/ : /ENOENT|ENOTDIR/, kind);
    assert.deepEqual(f.snapshot(), before);
  }
});

// T534: the release is the verification. A copy of the built plugin, as an install puts it, needs no evidence of its own.
function installedPlugin(t) {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'sage-install-')));
  t.after(() => rmSync(base, { recursive: true, force: true }));
  const codexHome = join(base, 'codex-home'), plugin = join(codexHome, 'plugins', 'cache', 'sage', 'sage', 'local');
  cpSync(fileURLToPath(new URL('../../../plugins/sage-codex', import.meta.url)), plugin, { recursive: true });
  const project = join(base, 'project'); mkdirSync(project);
  const env = { ...process.env, HOME: base, CODEX_HOME: codexHome, SAGE_HOME: join(base, 'sage'), SAGE_TEST_PIDS: '{}' };
  tool.sage(['init', '--project', project], env);
  const evidence = join(base, 'owner.md'); writeFileSync(evidence, 'SIMULATED direct owner instruction.');
  const call = (action, extra = {}) => spawnSync(process.execPath, [join(plugin, 'skills', 'sage', 'workflow.mjs')], { env, encoding: 'utf8',
    input: JSON.stringify({ action, project, session: 'install-session', ...extra }) });
  const owner = text => call('owner', { text, directOwner: true, evidence });
  return { plugin, call, owner };
}
test('T534 a fresh install turns autopilot on with no capability evidence', t => {
  const f = installedPlugin(t);
  assert.equal(f.owner('sage mode on').status, 0);
  const on = f.owner('autopilot on');
  assert.equal(on.status, 0, on.stderr);
  assert.equal(JSON.parse(on.stdout).autopilot, true);
  assert.equal(JSON.parse(f.call('status').stdout).publisherVerified, true);
});
test('T534 a changed or missing publisher file refuses autopilot and says to reinstall', t => {
  for (const change of ['workflow', 'core', 'missing']) {
    const f = installedPlugin(t);
    assert.equal(f.owner('sage mode on').status, 0);
    if (change === 'workflow') appendFileSync(join(f.plugin, 'skills', 'sage', 'workflow.mjs'), '\n// changed\n');
    else if (change === 'core') appendFileSync(join(f.plugin, 'core', 'state.mjs'), '\n// changed\n');
    else rmSync(join(f.plugin, 'skills', 'sage', 'publisher.json'));
    const on = f.owner('autopilot on');
    assert.equal(on.status, 1, change);
    assert.match(on.stderr, /does not match its release .*reinstall sage/, change);
    assert.match(on.stderr, change === 'core' ? /core\/state\.mjs/ : change === 'workflow' ? /skills\/sage\/workflow\.mjs/ : /publisher\.json/, change);
    const status = JSON.parse(f.call('status').stdout);
    assert.equal(status.autopilot, false); assert.equal(status.publisherVerified, false); assert.match(status.publisherFault, /reinstall sage/);
  }
});
test('T534 publish finds the one remote whose URL is the repository, whatever its name', t => {
  const f = fixture(t); f.enable();
  f.git('remote', 'rename', 'origin', 'github');
  f.git('remote', 'add', 'other', 'git@github.com:example/elsewhere.git');
  assert.equal(f.invoke('publish', { task: 'T1', sha: f.head }).publication.outcome, 'merged');
  assert.equal(f.puts(), 1);
});
test('T534 publish refuses when no remote or two remotes point to the repository', t => {
  const none = fixture(t); none.enable();
  none.git('remote', 'set-url', 'origin', 'https://github.com/example/elsewhere.git');
  assert.throws(() => none.invoke('publish', { task: 'T1', sha: none.head }), /No remote of this checkout points to github.com\/example\/project/);
  const two = fixture(t); two.enable();
  two.git('remote', 'add', 'github', 'git@github.com:Example/Project.git');
  assert.throws(() => two.invoke('publish', { task: 'T1', sha: two.head }), /More than one remote \(github, origin\) points to github.com\/example\/project/);
  assert.equal(none.puts() + two.puts(), 0);
});
