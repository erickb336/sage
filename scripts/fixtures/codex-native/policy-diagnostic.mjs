// Fixture-only exception capture. Never replace the original policy error.
import { constants, closeSync, fstatSync, lstatSync, mkdirSync, openSync, readFileSync, readdirSync, realpathSync, writeFileSync } from "node:fs";
import { join, relative, isAbsolute } from "node:path";
export function capturePolicyFailure(root, error) {
  const base=realpathSync(root), rows=[], errors=[];
  let entries=0,bytes=0;
  const visit=path=>{
    const rel=relative(base,path);
    if(!rel || rel.startsWith("..") || isAbsolute(rel)) throw Error("diagnostic_outside_fixture");
    if(++entries>128) throw Error("diagnostic_entry_bound");
    const stat=lstatSync(path);
    if(stat.isSymbolicLink()) throw Error("diagnostic_symlink_refused");
    if(stat.isDirectory()) {for(const name of readdirSync(path))visit(join(path,name));return;}
    let fd;
    try {
      fd=openSync(path,constants.O_RDONLY|constants.O_NOFOLLOW);
      const opened=fstatSync(fd);
      if(!opened.isFile() || opened.size>65536 || bytes+opened.size>262144) throw Error("diagnostic_size_bound");
      const data=readFileSync(fd);
      if(data.length!==opened.size) throw Error("diagnostic_file_changed");
      bytes+=data.length;rows.push({path:rel,text:data.toString("utf8")});
    } finally {if(fd!==undefined)closeSync(fd);}
  };
  try {visit(join(base,"logbook"));}catch(caught){errors.push(caught.code??caught.message);}
  const directory=join(base,"diagnostics");
  try {mkdirSync(directory,{mode:0o700});}catch(caught){if(caught.code!=="EEXIST")throw caught;}
  if(lstatSync(directory).isSymbolicLink() || realpathSync(directory)!==directory) throw Error("diagnostic_directory_refused");
  writeFileSync(join(directory,"policy-failure.json"),JSON.stringify({message:String(error?.message??error).slice(0,4096),stack:String(error?.stack??"").slice(0,16384),rows,errors,bytes}),{flag:"wx",mode:0o600});
}
