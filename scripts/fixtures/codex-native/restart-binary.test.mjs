import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync,symlinkSync,mkdirSync,mkdtempSync,rmSync,writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { requireNativeExecutable,resolveRestartBinary } from "./restart-binary.mjs";
test("restart abrupt native mode rejects executable script overrides",t=>{
 const root=mkdtempSync(join(tmpdir(),"sage-restart-binary-test-"));t.after(()=>rmSync(root,{recursive:true,force:true}));
 const script=join(root,"codex");writeFileSync(script,"#!/bin/sh\nprintf 'codex-cli 0.160.0'\n");chmodSync(script,0o700);
 assert.throws(()=>resolveRestartBinary({override:script}),/requires_direct_native_binary/);
 const elf=join(root,"native");writeFileSync(elf,Buffer.from("7f454c4600000000","hex"));chmodSync(elf,0o700);
 assert.equal(requireNativeExecutable(elf).format,"ELF");
});
test("restart resolves installed package vendor metadata without running its launcher",t=>{
 const root=mkdtempSync(join(tmpdir(),"sage-restart-package-test-"));t.after(()=>rmSync(root,{recursive:true,force:true}));
 mkdirSync(join(root,"bin"));writeFileSync(join(root,"package.json"),JSON.stringify({name:"@openai/codex",version:"0.160.0"}));
 const launcher=join(root,"bin/codex.js");writeFileSync(launcher,"#!/usr/bin/env node\nthrow Error('must not execute');\n");chmodSync(launcher,0o700);
 const vendor=join(root,"vendor/aarch64-apple-darwin/bin");mkdirSync(vendor,{recursive:true});writeFileSync(join(vendor,"codex"),Buffer.from("cffaedfe00000000","hex"));chmodSync(join(vendor,"codex"),0o700);
 // PATH name is normally a symlink to codex.js. Override remains intentionally stricter.
 symlinkSync(launcher,join(root,"bin/codex"));
 const result=resolveRestartBinary({path:join(root,"bin"),platform:"darwin",arch:"arm64"});
 assert.equal(result.format,"Mach-O");assert.equal(result.packageVersion,"0.160.0");assert(result.file.endsWith("/vendor/aarch64-apple-darwin/bin/codex"));
});
