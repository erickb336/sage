// Preserve only bounded evidence from the disposable fixture, never installed config or credentials.
import { constants, existsSync, closeSync, fstatSync, mkdirSync, mkdtempSync, openSync, readFileSync, readdirSync, realpathSync, writeFileSync } from "node:fs";
import { join, relative, isAbsolute } from "node:path";
import { tmpdir } from "node:os";

export function preserveFollowupCapacityEvidence(root, summary) {
  const base=realpathSync(root), destination=mkdtempSync(join(tmpdir(),"sage-t2-followup-capacity-evidence-"));
  const errors=[];let files=0,bytes=0,entries=0;
  const visit=(source,target,depth=0)=>{
    try {
      if(depth>16 || ++entries>512) throw Error("evidence_entry_bound");
      const rel=relative(base,realpathSync(source));
      if(!rel || rel.startsWith("..") || isAbsolute(rel)) throw Error("evidence_outside_fixture");
      mkdirSync(target,{recursive:true,mode:0o700});
      for(const row of readdirSync(source,{withFileTypes:true})) {
        if(++entries>512) throw Error("evidence_entry_bound");
        const from=join(source,row.name),to=join(target,row.name);
        if(row.isSymbolicLink()) { errors.push({path:relative(base,from),reason:"symlink_refused"});continue; }
        if(row.isDirectory()) {visit(from,to,depth+1);continue;}
        if(!row.isFile()) {errors.push({path:relative(base,from),reason:"non_file_refused"});continue;}
        let fd;
        try {
          fd=openSync(from,constants.O_RDONLY|constants.O_NOFOLLOW);
          const stat=fstatSync(fd);
          if(!stat.isFile() || stat.size>16*1024*1024 || files>=256 || bytes+stat.size>64*1024*1024) throw Error("evidence_size_bound");
          const data=readFileSync(fd);
          if(data.length!==stat.size) throw Error("evidence_file_changed");
          writeFileSync(to,data,{flag:"wx",mode:0o600});files++;bytes+=data.length;
        } catch(error) {errors.push({path:relative(base,from),reason:error.code??error.message});}
        finally {if(fd!==undefined)closeSync(fd);}
      }
    } catch(error) {errors.push({path:relative(base,source),reason:error.code??error.message});}
  };
  for(const path of ["codex/sessions","admission","events","observations"])
    visit(join(base,path),join(destination,path));
  if(existsSync(join(base,"diagnostics"))) visit(join(base,"diagnostics"),join(destination,"diagnostics"));
  const manifest={...summary,verified:summary.verified===true&&errors.length===0,complete:errors.length===0,files,bytes,errors,simulatedModel:true};
  writeFileSync(join(destination,"manifest.json"),JSON.stringify(manifest,null,2),{flag:"wx",mode:0o600});
  return {destination,...manifest};
}
