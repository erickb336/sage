import { constants, closeSync, fstatSync, lstatSync, mkdirSync, mkdtempSync, openSync, readFileSync, readdirSync, realpathSync, writeFileSync } from "node:fs";
import { join, relative, isAbsolute } from "node:path";
import { tmpdir } from "node:os";

// Only these isolated fixture trees may leave the disposable root. No installed state is read.
export function preserveRestartEvidence(root, summary) {
 const base=realpathSync(root),destination=realpathSync(mkdtempSync(join(tmpdir(),"sage-t4-restart-evidence-")));
 let files=0,bytes=0,entries=0;const errors=[];
 const copy=(source,target,depth=0)=>{
  const name=relative(base,source);let fd;
  try {
   if(!name||name.startsWith("..")||isAbsolute(name)||depth>16||++entries>512)throw Error("restart_evidence_path_bound");
   let cursor=base;for(const component of name.split("/")){cursor=join(cursor,component);if(lstatSync(cursor).isSymbolicLink())throw Error("restart_evidence_symlink");}
   const info=lstatSync(source);if(info.isSymbolicLink())throw Error("restart_evidence_symlink");
   if(info.isDirectory()){mkdirSync(target,{mode:0o700});for(const child of readdirSync(source))copy(join(source,child),join(target,child),depth+1);return;}
   if(!info.isFile())throw Error("restart_evidence_not_regular");
   fd=openSync(source,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);const stat=fstatSync(fd);
   if(!stat.isFile()||stat.size>16*1024*1024||files>=256||bytes+stat.size>64*1024*1024)throw Error("restart_evidence_size_bound");
   const content=readFileSync(fd);if(content.length!==stat.size)throw Error("restart_evidence_changed");
   writeFileSync(target,content,{flag:"wx",mode:0o600});files++;bytes+=content.length;
  }catch(error){errors.push({path:name,reason:error.code??error.message});}
  finally{if(fd!==undefined)closeSync(fd);}
 };
 for(const name of ["sessions","admission","events","observations","logbook","restart"]){
  const source=name==="sessions"?join(base,"codex/sessions"):join(base,name);
  copy(source,join(destination,name));
 }
 const manifest={...summary,complete:errors.length===0,verified:summary.verified===true&&errors.length===0,files,bytes,errors};
 writeFileSync(join(destination,"manifest.json"),JSON.stringify(manifest,null,2),{flag:"wx",mode:0o600});
 return{destination,...manifest};
}
