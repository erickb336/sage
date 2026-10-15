import { deadline } from "./restart-rpc.mjs";

// Capture and every cleanup action are independent. A broken recorder cannot strand another owner.
export async function cleanupRestart({ capture, handles, closeResponses, closeServer, removeRoot, timeout=30000 }) {
 const errors=[];let evidence,rootRemoved=false;
 const attempt=async(phase,action)=>{try{return await action();}catch(error){errors.push({phase,message:String(error?.message??error)});}};
 await attempt("capture",async()=>{evidence=await capture();if(evidence?.complete!==true)throw Error("restart_capture_incomplete");});
 await attempt("responses",closeResponses);
 for(const [index,handle]of handles.entries()) {
  if(handle.closed)continue;
  await attempt(`handle-${index}-eof`,()=>handle.eof());
  if(!handle.closed) {
   try{await deadline(handle.stopped,timeout,"cleanup_eof_deadline");}
   catch(error){
    errors.push({phase:`handle-${index}-wait`,message:error.message});
    await attempt(`handle-${index}-signal`,()=>handle.abrupt());
    await attempt(`handle-${index}-terminal`,()=>deadline(handle.stopped,timeout,"cleanup_handle_not_terminal"));
   }
  }
 }
 await attempt("server",()=>deadline(Promise.resolve().then(closeServer),timeout,"cleanup_server_deadline"));
 const ownedHandlesClosed=handles.every(handle=>handle.closed);
 // Preserve the original profile if capture or teardown was incomplete.
 if(evidence?.complete && ownedHandlesClosed && !errors.length)await attempt("remove-root",async()=>{await removeRoot();rootRemoved=true;});
 return {evidence,errors,ownedHandlesClosed,complete:evidence?.complete===true&&ownedHandlesClosed&&rootRemoved&&!errors.length};
}
