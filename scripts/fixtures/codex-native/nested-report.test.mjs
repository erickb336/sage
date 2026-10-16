import {test} from "node:test";
import assert from "node:assert/strict";
import {createHash} from "node:crypto";
import {createNestedReportFlow,NESTED_CALLS as ids} from "./nested-report.mjs";

// These fixed API results exercise the probe's refusal sensitivity, not native execution.
function fixture(){
 const hash=text=>createHash("sha256").update(text).digest("hex");
 const target={branch:"codex/fixture",sha:"a".repeat(40),round:0,cycle:1};
 const reviewer="STATUS done\nRESULT CLEAN\nEVIDENCE fixed\nFINDINGS none\nQUESTIONS none\nNOT VERIFIED real review\nBRANCH codex/fixture";
 const receipt={decision:"report-ready",assignment:"review-assignment",task:"T1",run:"R2",child:"reviewer",turn:"review-turn",reportMessage:"message",reportHash:hash(reviewer),report:{}};
 let leadText,book={tasks:[{id:"T1"}],runs:[],ledger:[],findings:[],gates:[],decisions:[]};const outputs=[];
 const flow=createNestedReportFlow({integrated:{reviewTarget:target,readLogbook:()=>structuredClone(book),readJournal:()=>({reports:[{},{}],completions:[{},{}]}),mergeReady:()=>false,readRunReport:file=>file==="lead.md"?leadText:reviewer},
 check:(value,message)=>assert(value,message),respond:(_,item)=>outputs.push(item),message:text=>({text}),call:(id,name,args)=>({id,name,args}),print:()=>{},identities:()=>({lead:"lead",reviewer:"reviewer"}),reviewerReport:reviewer,parentMarker:"parent",setReviewerTask:()=>{},setLeadReport:text=>{leadText=text;}});
 const info=(values={})=>({outputs:values,grandchildPromptSeen:true,...Object.fromEntries(["prepareTools","reportTools","recordTools","finishTools","inspectTools","acceptTools"].map(name=>[name,[{name}]]))});
 const leadToRecord=()=>{
 flow.lead(info({probe_child_control:{resources:[]}}),null);
 flow.lead(info({[ids.prepare]:{decision:"prepared",fork_turns:"none",review:target,message:"brief",name:"probe_grandchild"}}),null);
 flow.lead(info({[ids.spawn]:{task_name:"/root/probe_child/probe_grandchild"}}),null);
 flow.lead(info({[ids.wait]:{}}),null);
 flow.lead(info({[ids.list]:{agents:[{agent_name:"/root/probe_child/probe_grandchild",agent_status:{completed:reviewer}}]}}),null);
 flow.lead(info({[ids.read]:receipt}),null);
 };
 const toInspect=()=>{
 leadToRecord();flow.lead(info({[ids.record]:{...receipt,decision:"report-recorded"}}),null);
 const leadReceipt={...receipt,assignment:"lead-assignment",run:"R1",child:"lead",turn:"lead-turn",reportHash:hash(leadText),report:{EVIDENCE:JSON.stringify({assignment:receipt.assignment,reportHash:receipt.reportHash})}};
 flow.chief(0,info(),null,leadText);flow.chief(1,info({[ids.leadRead]:leadReceipt}),null,leadText);
 flow.chief(2,info({[ids.leadRecord]:{...leadReceipt,decision:"report-recorded"}}),null,leadText);
 flow.chief(3,info({[ids.leadFinish]:{decision:"run-finished",run:"R1"}}),null,leadText);
 return {decision:"recorded-report",assignment:receipt.assignment,reportHash:receipt.reportHash,task:"T1",run:"R2",turn:receipt.turn,text:reviewer,role:"code-reviewer",issuer:"lead",child:"reviewer",review:target};
 };
 const finish=()=>{
   const report=toInspect();flow.chief(4,info({[ids.inspect]:report}),null,leadText);
   book.runs=[{id:"R1",task:"T1",status:"done",report:"lead.md"},{id:"R2",task:"T1",status:"done",report:"review.md"}];
   flow.chief(5,info({[ids.finish]:{decision:"run-finished",run:"R2"}}),null,leadText);
   book.ledger=[{run:"R2",sha:target.sha,kind:"review-clean"}];
   const accepted={decision:"review-accepted",run:"R2",sha:target.sha,kind:"review-clean",cycle:1};
   flow.chief(6,info({[ids.accept]:accepted}),null,leadText);
   return ()=>flow.chief(7,info({[ids.retry]:{...accepted,decision:"already-accepted"}}),null,leadText);
 };
 return {flow,info,receipt,leadToRecord,toInspect,outputs,target,reviewer,finish,mutate:()=>{book.gates.push({id:"unexpected"});}};
}
test("nested report probe accepts exact ownership and refuses foreign report provenance",()=>{
 const good=fixture(),report=good.toInspect();good.flow.chief(4,good.info({[ids.inspect]:report}),null,"");
 assert.deepEqual(JSON.parse(good.outputs.at(-1).arguments),{assignment:good.receipt.assignment,reportHash:good.receipt.reportHash});
 for(const change of [{issuer:"foreign"},{child:"foreign"},{role:"lead"}]){const bad=fixture(),saved=bad.toInspect();assert.throws(()=>bad.flow.chief(4,bad.info({[ids.inspect]:{...saved,...change}}),null,""),/nested_chief_inspection_invalid/);}
});
test("nested report probe refuses substituted receipt identity and report bytes",()=>{
 for(const change of [{assignment:"other"},{reportHash:"b".repeat(64)},{run:"R1"},{turn:"other"},{text:"substituted"}]){const bad=fixture(),saved=bad.toInspect();assert.throws(()=>bad.flow.chief(4,bad.info({[ids.inspect]:{...saved,...change}}),null,""),/nested_chief_inspection_invalid/);}
 const bad=fixture();bad.leadToRecord();assert.throws(()=>bad.flow.lead(bad.info({[ids.record]:{...bad.receipt,decision:"report-recorded",child:"foreign"}}),null),/nested_review_record_invalid/);
});
test("nested report probe cannot emit completion after denied first tools",()=>{
 const lead=fixture();assert.throws(()=>lead.flow.lead(lead.info({probe_child_control:"Sage could not verify this tool call."}),null));assert.equal(lead.outputs.length,0);
 const reviewer=fixture();reviewer.flow.reviewer(reviewer.info(),null);assert.throws(()=>reviewer.flow.reviewer(reviewer.info({[ids.control]:"denied"}),null));assert.equal(reviewer.outputs.length,1);
 const good=fixture();good.flow.reviewer(good.info(),null);good.flow.reviewer(good.info({[ids.control]:{resources:[]}}),null);assert.equal(good.outputs.at(-1).text,good.reviewer);
});

test("nested report probe verifies exact finished reports and unchanged acceptance retry",()=>{
 const good=fixture();good.finish()();assert.equal(good.outputs.at(-1).text,"parent");
 const bad=fixture(),retry=bad.finish();bad.mutate();assert.throws(retry,/nested_retry_mutated_state/);
});
