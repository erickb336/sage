// Report structure only. A complete report does not prove its claims or authorize a verdict.
export const REPORT_FIELDS = Object.freeze(["STATUS", "RESULT", "EVIDENCE", "FINDINGS", "QUESTIONS", "NOT VERIFIED", "BRANCH"]);

/** Presence check for one bounded stop correction, matching the Claude hook's field rule.
 * This does not parse values or accept a report. */
export function missingReportFields(text) {
  if (typeof text !== "string") throw Error("Report text is required");
  const space = String.raw`[^\S\r\n  ]`;
  return REPORT_FIELDS.filter(field => !new RegExp(`^(?:${space}|[*_#|>-])*${field}\\b`, "m").test(text));
}
