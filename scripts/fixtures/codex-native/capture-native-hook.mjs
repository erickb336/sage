// Test-only observer. No tool strings are executed. Never read outside this fresh test profile.
import {readFileSync,writeFileSync,realpathSync,openSync,readSync,closeSync,constants,fstatSync} from 'node:fs';
import {dirname,join,relative,isAbsolute} from 'node:path';
import {fileURLToPath} from 'node:url';
import {readNativeCommand} from './native-identity.mjs';
import {randomUUID,createHash} from 'node:crypto';
const root=dirname(fileURLToPath(import.meta.url));
const input=JSON.parse(readFileSync(0,'utf8'));
const record=Object.fromEntries(['hook_event_name','session_id','agent_id','turn_id','tool_name','tool_use_id'].filter(k=>typeof input[k]==='string').map(k=>[k,input[k]]));
// Record field types only; command content stays private.
record.toolInputShape=Object.fromEntries(Object.entries(input.tool_input??{}).map(([k,v])=>[k,typeof v]));
record.fixedCommandMatched=input.tool_input?.command==='printf sage-native-command-ok; pwd';
if(record.fixedCommandMatched&&input.hook_event_name==='PreToolUse'){
 record.commandHookFields=Object.keys(input).sort();
 record.hookCwdIsWorkspace=input.cwd===join(root,'workspace');
 record.hookCwdIsCommandDirectory=input.cwd===join(root,'workspace/command-workdir');
 try{
  const args=readNativeCommand(input.transcript_path,{sessionsDir:realpathSync(join(root,'codex/sessions'))},
   {session:input.session_id,actor:input.session_id,parent:null,path:'/root',turn:input.turn_id,call:input.tool_use_id,command:input.tool_input.command});
  const transcript=realpathSync(input.transcript_path);
  if(!transcript.startsWith(realpathSync(join(root,'codex/sessions'))+'/'))throw Error('outside_test_profile');
  const contextFd=openSync(transcript,constants.O_RDONLY|constants.O_NOFOLLOW);
  let contexts;
  try{
   const size=fstatSync(contextFd).size;
   if(!fstatSync(contextFd).isFile()||size>256*1024)throw Error('invalid_test_transcript');
   const bytes=Buffer.alloc(size);
   if(readSync(contextFd,bytes,0,size,0)!==size)throw Error('incomplete_test_transcript');
   contexts=bytes.toString('utf8').split('\n').filter(Boolean).map(line=>JSON.parse(line))
    .filter(row=>row.type==='turn_context'&&row.payload?.turn_id===input.turn_id);
  }finally{closeSync(contextFd);}
  record.turnContextFields=contexts.map(row=>Object.keys(row.payload).sort());
  record.turnCwdIsWorkspace=contexts.length===1&&contexts[0].payload.cwd===join(root,'workspace');
  record.commandTranscript={fields:Object.keys(args).sort(),fixedCommand:args.cmd==='printf sage-native-command-ok; pwd',
   fixedShell:args.shell==='/bin/sh',fixedDirectory:args.workdir===join(root,'workspace/command-workdir'),ttyFalse:args.tty===false};
 }catch(error){record.commandTranscript={error:error.message};}
}
if(input.hook_event_name==='PreToolUse'&&input.tool_name==='collaborationfollowup_task'){
 const base=realpathSync(join(root,'codex/sessions')),transcript=realpathSync(input.transcript_path);
 const rel=relative(base,transcript);
 if(!rel||rel.startsWith('..')||isAbsolute(rel))throw Error('outside_fresh_session_tree');
 writeFileSync(join(root,'followup-dispatch.json'),JSON.stringify({transcript,session:input.session_id,
  turn:input.turn_id,call:input.tool_use_id}),{flag:'wx'});
}
if(typeof input.tool_input?.task_name==='string')record.inputTaskName=input.tool_input.task_name;
if(input.hook_event_name==='PostToolUse'){
 const value=input.tool_response;
 let response=value;
 if(typeof value==='string'){try{response=JSON.parse(value);}catch{response=null;}}
 if(typeof response?.task_name==='string')record.resultTaskName=response.task_name;
 record.responseShape=Array.isArray(value)?'array':typeof value;
 if(value&&typeof value==='object')record.responseKeys=Object.keys(value);
}
if(['SubagentStart','SubagentStop'].includes(input.hook_event_name)){
 record.inputKeys=Object.keys(input).sort();
 try{
  const base=realpathSync(join(root,'codex/sessions'));
  if(!/^[0-9a-f-]{36}$/.test(input.agent_id))throw Error('invalid_test_child');
  const saved=join(root,'child-path-'+input.agent_id+'.json');
  if(input.hook_event_name==='SubagentStart')writeFileSync(saved,JSON.stringify(input.transcript_path),{flag:'wx'});
  const path=realpathSync(JSON.parse(readFileSync(saved,'utf8')));
  record.childTranscriptFields=Object.keys(input).filter(key=>input[key]===path).sort();
  const rel=relative(base,path);
  if(!rel||rel.startsWith('..')||isAbsolute(rel))throw Error('outside_fresh_session_tree');
  const fd=openSync(path,constants.O_RDONLY|constants.O_NOFOLLOW);
  try{
   if(!fstatSync(fd).isFile())throw Error('not_regular_file');
   const buf=Buffer.alloc(256*1024),size=readSync(fd,buf,0,buf.length,0),end=buf.subarray(0,size).indexOf(10);
   if(end<0)throw Error('missing_or_large_header');
   const header=JSON.parse(buf.subarray(0,end).toString('utf8'));
   if(header.type!=='session_meta'||header.payload.id!==input.agent_id)throw Error('wrong_child_header');
   if(input.hook_event_name==='SubagentStop'){
    record.stopHookActive=input.stop_hook_active;
    record.lastMessageHash=typeof input.last_assistant_message==='string'?createHash('sha256').update(input.last_assistant_message).digest('hex'):null;
    const rows=buf.subarray(0,size).toString('utf8').split('\n').filter(Boolean).map(line=>JSON.parse(line));
    let turn,context;
    record.terminalAtCallback=rows.some(row=>row.type==='event_msg'&&row.payload?.type==='task_complete'&&row.payload.turn_id===input.turn_id);
    record.assignments=[];
    for(const row of rows){
     const p=row.payload;
     if(row.type==='event_msg'&&p?.type==='task_started'){turn=p.turn_id;context=undefined;}
     if(row.type==='turn_context')context=p?.turn_id;
     if(row.type==='response_item'&&p?.type==='agent_message'){
      if(!turn||context!==turn||!Array.isArray(p.content))throw Error('task_without_turn_context');
      const parts=p.content.filter(part=>part.type==='encrypted_content');
      if(parts.length===0)continue;
      if(parts.length!==1||typeof parts[0].encrypted_content!=='string')throw Error('unsupported_task_content');
      record.assignments.push({turn,message:p.id,author:p.author,recipient:p.recipient,
       taskHash:createHash('sha256').update(parts[0].encrypted_content).digest('hex')});
     }
    }
   }
   record.metadata=Object.fromEntries(['id','session_id','parent_thread_id','agent_path'].filter(k=>Object.hasOwn(header.payload,k)).map(k=>[k,header.payload[k]]));
  }finally{closeSync(fd);}
 }catch(e){record.captureError=e.code??e.message;}
}
writeFileSync(join(root,'events',randomUUID()+'.json'),JSON.stringify(record),{flag:'wx'});

if(process.argv[2] === "--deny-spawn" && input.hook_event_name === "PreToolUse" && input.tool_name === "collaborationspawn_agent") {
 process.stdout.write(JSON.stringify({hookSpecificOutput:{hookEventName:"PreToolUse",permissionDecision:"deny",permissionDecisionReason:"sage-native-denial-fixture"}}));
}
