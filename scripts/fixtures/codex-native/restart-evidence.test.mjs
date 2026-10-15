import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync,mkdtempSync,writeFileSync,readFileSync,rmSync,symlinkSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { preserveRestartEvidence } from "./restart-evidence.mjs";
test("restart failed phases remain unverified and external links never copy",t=>{
 const root=mkdtempSync(join(tmpdir(),"sage-restart-evidence-test-"));t.after(()=>rmSync(root,{recursive:true,force:true}));
 for(const name of ["codex/sessions","admission","events","observations","logbook","restart"])mkdirSync(join(root,name),{recursive:true});
 writeFileSync(join(root,"restart","phase.json"),'{"phase":"held"}');
 writeFileSync(join(root,"secret"),"do not copy");symlinkSync(join(root,"secret"),join(root,"logbook","outside"));
 const result=preserveRestartEvidence(root,{verified:false,failure:"native unavailable"});t.after(()=>rmSync(result.destination,{recursive:true,force:true}));
 assert.equal(result.verified,false);assert.equal(result.complete,false);assert.equal(result.files,1);
 assert.equal(readFileSync(join(result.destination,"restart","phase.json"),"utf8"),'{"phase":"held"}');
 assert.equal(result.errors[0].reason,"restart_evidence_symlink");
});
