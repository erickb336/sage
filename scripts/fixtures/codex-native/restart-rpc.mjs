import { StringDecoder } from "node:string_decoder";
import { EventEmitter } from "node:events";

// One tracked stdio connection. EOF requests closure; only the child close event proves exit.
export function restartRpc(child, { record = () => {}, limit = 2 * 1024 * 1024 } = {}) {
  const events=new EventEmitter(), pending=new Map();
  let sequence=0,buffer="",bytes=0,closed=false,terminal,fatal;
  const decoder=new StringDecoder("utf8");
  const stopped=new Promise(resolve=>{terminal=resolve;});
  const fail=error=>{fatal??=error;for(const item of pending.values())item.reject(error);pending.clear();events.emit("failure",error);};
  const send=message=>{if(closed)throw Error("restart_transport_closed");if(fatal)throw fatal;child.stdin.write(JSON.stringify(message)+"\n");};
  child.stdin.on("error",fail);
  child.on("error",fail);
  child.stderr.on("data",data=>{try{record({kind:"stderr",text:String(data).slice(0,4096)});}catch(error){fail(error);}});
  child.stdout.on("data",data=>{
    try {
      bytes+=data.length;if(bytes>limit)throw Error("restart_rpc_output_bound");
      buffer+=decoder.write(data);
      while(buffer.includes("\n")) {
        const index=buffer.indexOf("\n"),line=buffer.slice(0,index);buffer=buffer.slice(index+1);
        if(!line.trim())continue;
        const message=JSON.parse(line);record({kind:"rpc",message});
        if(message.id!==undefined && !message.method) {
          const item=pending.get(message.id);if(!item)throw Error("restart_rpc_unknown_response");
          pending.delete(message.id);message.error?item.reject(Error(JSON.stringify(message.error))):item.resolve(message.result);
        } else if(message.id!==undefined) {
          // No external approval or unplanned server-side action is authorized by this fixture.
          send({id:message.id,error:{code:-32601,message:"Outside the fixed restart fixture"}});
          events.emit("serverRequest",message);
        } else events.emit("notification",message);
      }
    }catch(error){fail(error);}
  });
  child.once("close",(code,signal)=>{
    closed=true;const result={code,signal};try{record({kind:"close",...result});}catch(error){fail(error);}
    fail(Error("restart_transport_closed"));terminal(result);
  });
  return {events,stopped,get closed(){return closed;},
    request(method,params={}) {
      const id=++sequence;
      return new Promise((resolve,reject)=>{pending.set(id,{resolve,reject});try{send({id,method,params});}catch(error){pending.delete(id);reject(error);}});
    },
    notify:(method,params={})=>send({method,params}),
    eof(){try{record({kind:"requested-eof"});}catch(error){fail(error);}finally{child.stdin.end();}},
    abrupt(){if(closed)throw Error("restart_already_closed");try{record({kind:"requested-signal",signal:"SIGKILL"});}catch(error){fail(error);}if(!child.kill("SIGKILL"))throw Error("restart_signal_not_sent");},
  };
}

export async function deadline(promise, milliseconds, label) {
  let timer;
  try {return await Promise.race([promise,new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error(label)),milliseconds);})]);}
  finally {clearTimeout(timer);}
}

export function restartOutcome(mode, terminal) {
  if(!terminal)return "not-terminal";
  if(mode==="clean-eof")return terminal.code===0 && terminal.signal===null?"clean-exit":"nonclean-exit";
  return terminal.signal==="SIGKILL"?"tracked-abrupt-exit":"unexpected-exit";
}

// Own the version-check process even when it never prints a complete version or fails to spawn.
export function trackedVersion(child, limit=256) {
 let closed=false,text="",error;let terminal;
 const stopped=new Promise(resolve=>{terminal=resolve;});
 child.stdout.on("data",data=>{if(Buffer.byteLength(text)+data.length>limit)error??=Error("restart_version_output_bound");else text+=data;});
 child.stderr.resume();child.stdin.on("error",cause=>{error??=cause;});child.on("error",cause=>{error??=cause;});
 child.once("close",(code,signal)=>{closed=true;terminal({code,signal});});
 return {stopped,get closed(){return closed;},get text(){if(error)throw error;return text;},
  eof:()=>child.stdin.end(),abrupt:()=>{if(!closed&&!child.kill("SIGKILL"))throw Error("restart_signal_not_sent");}};
}
