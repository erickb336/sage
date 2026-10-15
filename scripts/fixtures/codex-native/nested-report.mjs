// Fixed simulated responses for a real native lead -> reviewer -> chief report route.
import { freshControlCompletion } from "./fresh-control.mjs";
import { createHash } from "node:crypto";
export const NESTED_CALLS = Object.freeze(Object.fromEntries([
  "prepare", "spawn", "wait", "list", "read", "record", "control", "leadRead", "leadRecord", "leadFinish",
  "inspect", "finish", "accept", "retry",
].map(name => [name, `nested_${name}`])));
export function createNestedReportFlow({ integrated, check, respond, message, call, print, identities,
  reviewerReport, parentMarker, setReviewerTask, setLeadReport }) {
  const ids = NESTED_CALLS, target = integrated.reviewTarget;
  const initial = integrated.readLogbook();
  let leadStep = 0, reviewerStep = 0, nestedReceipt, leadReceipt, accepted, acceptedBook, acceptedJournal;
  const hash = text => createHash("sha256").update(text).digest("hex");
  const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
  const ref = receipt => ({ assignment: receipt.assignment, reportHash: receipt.reportHash });
  const tool = (res, info, name, id, input) => {
    check(info[name]?.length === 1, `nested_${name}_missing`);
    respond(res, { type: "function_call", ...info[name][0], call_id: id, arguments: JSON.stringify(input) });
  };
  return {
    lead(info, res) {
      switch (leadStep++) {
        case 0: {
          check(Object.hasOwn(info.outputs, "probe_child_control"), "nested_lead_first_tool_missing");
          freshControlCompletion(info.outputs.probe_child_control,"verified");
          const brief = Object.fromEntries(["GOAL", "SCOPE", "CONTEXT", "DECISIONS", "ACCEPTANCE", "VERIFY", "BUDGET", "FORBIDDEN", "REPORT", "STANDING"]
            .map(key => [key, "Review the fixed temporary commit. Simulated evidence only."]));
          tool(res, info, "prepareTools", ids.prepare, { task: "T1", run: "R2", name: "probe_grandchild", role: "code-reviewer", reviewCycle: 1, brief });
          break;
        }
        case 1: {
          const prepared = info.outputs[ids.prepare];
          check(prepared?.decision === "prepared" && prepared.fork_turns === "none" && same(prepared.review, target), "nested_review_preparation_invalid");
          setReviewerTask(prepared.message);
          respond(res, call(ids.spawn, "spawn_agent", { task_name: prepared.name, message: prepared.message, fork_turns: prepared.fork_turns }));
          break;
        }
        case 2:
          check(info.outputs[ids.spawn]?.task_name === "/root/probe_child/probe_grandchild", "nested_reviewer_spawn_invalid");
          respond(res, call(ids.wait, "wait_agent", {})); break;
        case 3:
          check(info.outputs[ids.wait] !== undefined, "nested_reviewer_wait_missing");
          respond(res, call(ids.list, "list_agents", {})); break;
        case 4: {
          const reviewer = info.outputs[ids.list]?.agents?.find(row => row.agent_name === "/root/probe_child/probe_grandchild");
          check(reviewer?.agent_status?.completed === reviewerReport, "nested_reviewer_not_completed");
          tool(res, info, "reportTools", ids.read, { name: "probe_grandchild" }); break;
        }
        case 5: {
          const receipt = info.outputs[ids.read];
          check(receipt?.decision === "report-ready" && receipt.run === "R2" && receipt.child === identities().reviewer
            && receipt.reportHash === hash(reviewerReport), "nested_review_read_invalid");
          nestedReceipt = receipt;
          tool(res, info, "recordTools", ids.record, { name: "probe_grandchild", reportHash: receipt.reportHash }); break;
        }
        case 6: {
          const saved = info.outputs[ids.record];
          check(saved?.decision === "report-recorded" && same(saved, {...nestedReceipt,decision:"report-recorded"}), "nested_review_record_invalid");
          const text = ["STATUS done", "RESULT Review report recorded", `EVIDENCE ${JSON.stringify(ref(saved))}`,
            "FINDINGS none", "QUESTIONS none", "NOT VERIFIED real review or project checks", `BRANCH ${target.branch}`].join("\n");
          setLeadReport(text); respond(res, message(text)); break;
        }
        default: check(false, "unexpected_nested_lead_request");
      }
    },
    reviewer(info, res) {
      check(info.grandchildPromptSeen, "nested_reviewer_task_not_delivered");
      if (reviewerStep++ === 0) {
        respond(res, { type: "function_call", name: "list_mcp_resources", call_id: ids.control, arguments: "{}" });
      } else {
        check(reviewerStep === 2 && Object.hasOwn(info.outputs, ids.control), "nested_reviewer_binding_tool_missing");
        freshControlCompletion(info.outputs[ids.control],"verified");
        respond(res, message(reviewerReport));
      }
    },
    chief(step, info, res, leadText) {
      switch (step) {
        case 0: tool(res, info, "reportTools", ids.leadRead, { name: "probe_child" }); break;
        case 1: {
          leadReceipt = info.outputs[ids.leadRead];
          check(leadReceipt?.decision === "report-ready" && leadReceipt.run === "R1" && leadReceipt.child===identities().lead && leadReceipt.reportHash === hash(leadText)
            && same(JSON.parse(leadReceipt.report.EVIDENCE), ref(nestedReceipt)), "nested_lead_handoff_invalid");
          tool(res, info, "recordTools", ids.leadRecord, { name: "probe_child", reportHash: leadReceipt.reportHash }); break;
        }
        case 2:
          check(same(info.outputs[ids.leadRecord],{...leadReceipt,decision:"report-recorded"}), "nested_lead_record_missing");
          tool(res, info, "finishTools", ids.leadFinish, ref(leadReceipt)); break;
        case 3:
          check(info.outputs[ids.leadFinish]?.decision === "run-finished" && info.outputs[ids.leadFinish].run === "R1", "nested_lead_finish_missing");
          tool(res, info, "inspectTools", ids.inspect, JSON.parse(leadReceipt.report.EVIDENCE)); break;
        case 4: {
          const report = info.outputs[ids.inspect], identity = identities();
          check(report?.decision === "recorded-report" && same(ref(report),ref(nestedReceipt)) && report.task==="T1" && report.run==="R2" && report.turn===nestedReceipt.turn && report.text === reviewerReport && report.role === "code-reviewer"
            && report.issuer === identity.lead && report.child === identity.reviewer && same(report.review, target), "nested_chief_inspection_invalid");
          tool(res, info, "finishTools", ids.finish, ref(nestedReceipt)); break;
        }
        case 5:
          check(info.outputs[ids.finish]?.decision === "run-finished" && info.outputs[ids.finish].run === "R2", "nested_review_finish_missing");
          tool(res, info, "acceptTools", ids.accept, ref(nestedReceipt)); break;
        case 6:
          accepted = info.outputs[ids.accept];
          check(accepted?.decision === "review-accepted" && accepted.run === "R2" && accepted.sha === target.sha && accepted.kind === "review-clean" && accepted.cycle===target.cycle, "nested_acceptance_invalid");
          acceptedBook=integrated.readLogbook();acceptedJournal=integrated.readJournal();
          tool(res, info, "acceptTools", ids.retry, ref(nestedReceipt)); break;
        case 7: {
          check(same(info.outputs[ids.retry], { ...accepted, decision: "already-accepted" }), "nested_acceptance_retry_changed");
          const book = integrated.readLogbook(), journal = integrated.readJournal();
          check(same(book,acceptedBook)&&same(journal,acceptedJournal),"nested_retry_mutated_state");
          check(book.runs.length === 2 && book.runs.every(row => row.status === "done" && row.report), "nested_runs_not_finished");
          check(book.runs.find(row=>row.id==="R1")?.task==="T1" && book.runs.find(row=>row.id==="R2")?.task==="T1"
            && integrated.readRunReport(book.runs.find(row=>row.id==="R1").report)===leadText
            && integrated.readRunReport(book.runs.find(row=>row.id==="R2").report)===reviewerReport,"nested_run_report_substituted");
          check(book.ledger.length === 1 && book.ledger[0].run === "R2" && book.ledger[0].sha === target.sha
            && book.ledger[0].kind === "review-clean" && !integrated.mergeReady(), "nested_verdict_or_merge_invalid");
          check(["tasks", "findings", "gates", "decisions"].every(key => same(book[key], initial[key])), "nested_workflow_changed_task_or_gates");
          check(journal.reports.length === 2 && journal.completions.length === 2, "nested_receipt_or_completion_missing");
          print({ type: "nested_report_evidence", nativeAgents: 2, completedRuns: 2, savedReports: 2, recordedVerdicts: 1,
            leadRecordedOwnChild: true, chiefInspectedSavedReport: true, actualBranchHead: true, retryCreatedDuplicate: false,
            taskAndGatesUnchanged: true, mergeReady: false, simulatedModel: true, realReviewVerified: false });
          respond(res, message(parentMarker)); break;
        }
        default: check(false, "unexpected_nested_chief_request");
      }
    },
  };
}
