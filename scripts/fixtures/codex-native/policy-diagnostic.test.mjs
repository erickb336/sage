import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { capturePolicyFailure } from "./policy-diagnostic.mjs";
function fixture(t) {
  const root=mkdtempSync(join(tmpdir(),"sage-policy-diagnostic-test-"));
  t.after(()=>rmSync(root,{recursive:true,force:true}));
  mkdirSync(join(root,"logbook"));return root;
}
test("policy diagnostic preserves exception and isolated table",t=>{
  const root=fixture(t),error=new Error("fixed policy refusal");
  writeFileSync(join(root,"logbook","runs.tsv"),"id\tstatus\nR1\trunning\n");
  capturePolicyFailure(root,error);
  const saved=JSON.parse(readFileSync(join(root,"diagnostics","policy-failure.json")));
  assert.equal(saved.message,error.message);assert.equal(saved.stack,error.stack);
  assert.deepEqual(saved.errors,[]);assert.equal(saved.rows[0].text,"id\tstatus\nR1\trunning\n");
});
test("policy diagnostic refuses symlinks and oversized table content",t=>{
  const root=fixture(t);writeFileSync(join(root,"outside"),"must not copy");
  symlinkSync(join(root,"outside"),join(root,"logbook","link"));
  capturePolicyFailure(root,new Error("fixed"));
  const saved=JSON.parse(readFileSync(join(root,"diagnostics","policy-failure.json")));
  assert.deepEqual(saved.rows,[]);assert.deepEqual(saved.errors,["diagnostic_symlink_refused"]);
  const large=fixture(t);writeFileSync(join(large,"logbook","large"),"x".repeat(65537));
  capturePolicyFailure(large,new Error("fixed"));
  const bounded=JSON.parse(readFileSync(join(large,"diagnostics","policy-failure.json")));
  assert.deepEqual(bounded.rows,[]);assert.deepEqual(bounded.errors,["diagnostic_size_bound"]);
});
