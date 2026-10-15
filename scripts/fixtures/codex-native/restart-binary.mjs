import { accessSync, constants, closeSync, openSync, readFileSync, readSync, realpathSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { delimiter, dirname, join } from "node:path";

export function requireNativeExecutable(file) {
 const canonical=realpathSync(file);accessSync(canonical,constants.X_OK);
 if(!statSync(canonical).isFile())throw Error("restart_binary_not_regular");
 const fd=openSync(canonical,constants.O_RDONLY|constants.O_NOFOLLOW);const magic=Buffer.alloc(4);
 try{if(readSync(fd,magic,0,4,0)!==4)throw Error("restart_binary_header_missing");}finally{closeSync(fd);}
 const hex=magic.toString("hex");
 if(!["7f454c46","cffaedfe","cefaedfe","feedfacf","feedface","cafebabe","bebafeca","cafebabf","bfbafeca"].includes(hex))throw Error("restart_requires_direct_native_binary");
 return {file:canonical,format:hex==="7f454c46"?"ELF":"Mach-O"};
}

// Resolve the installed npm package exactly as its codex.js launcher does, without running that script.
// An explicit override must itself be native; it never silently selects another executable.
export function resolveRestartBinary({override,path=process.env.PATH,platform=process.platform,arch=process.arch}={}) {
 if(override)return requireNativeExecutable(override);
 const located=(path??"").split(delimiter).map(dir=>join(dir,"codex")).find(file=>{try{accessSync(file,constants.X_OK);return true;}catch{return false;}});
 if(!located)throw Error("restart_codex_not_found");
 try{return requireNativeExecutable(located);}catch(error){if(error.message!=="restart_requires_direct_native_binary")throw error;}
 const launcher=realpathSync(located),root=dirname(dirname(launcher));
 const meta=JSON.parse(readFileSync(join(root,"package.json"),"utf8"));
 if(meta.name!=="@openai/codex" || launcher!==join(root,"bin","codex.js"))throw Error("restart_unknown_launcher");
 const triples={"darwin-arm64":["aarch64-apple-darwin","@openai/codex-darwin-arm64"],"darwin-x64":["x86_64-apple-darwin","@openai/codex-darwin-x64"],"linux-arm64":["aarch64-unknown-linux-musl","@openai/codex-linux-arm64"],"linux-x64":["x86_64-unknown-linux-musl","@openai/codex-linux-x64"]};
 const target=triples[`${platform}-${arch}`];if(!target)throw Error("restart_native_platform_unsupported");
 const [triple,packageName]=target;let vendor;
 try{vendor=join(dirname(createRequire(launcher).resolve(packageName+"/package.json")),"vendor");}
 catch{vendor=join(root,"vendor");}
 const result=requireNativeExecutable(join(vendor,triple,"bin","codex"));
 return {...result,resolvedFrom:launcher,packageVersion:meta.version};
}
