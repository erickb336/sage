// Report structure only. A complete report does not prove its claims or authorize a verdict.
export const REPORT_FIELDS = Object.freeze(["STATUS", "RESULT", "EVIDENCE", "FINDINGS", "QUESTIONS", "NOT VERIFIED", "BRANCH"]);
const header = new RegExp(`^[ \t*_#|>-]*(${REPORT_FIELDS.join("|")})(?=$|[ \t:*_|])[ \t*_]*(?::|\\|)?[ \t]*(.*)$`);
const refuse = () => { throw Error("A report needs every required field and a valid status"); };

export function parseReport(text) {
  if (typeof text !== "string" || !text.trim() || Buffer.byteLength(text, "utf8") > 32 * 1024
    || text.includes("\0") || Buffer.from(text, "utf8").toString("utf8") !== text) refuse();
  const fenced = /^```(?:text)?\r?\n([\s\S]*)\r?\n```$/.exec(text.trim());
  const body = fenced ? fenced[1] : text;
  const fields = {};
  let current;
  for (const line of body.replace(/\r\n/g, "\n").split("\n")) {
    const match = header.exec(line);
    if (match) {
      current = match[1];
      if (Object.hasOwn(fields, current)) refuse();
      fields[current] = match[2];
    } else if (current) fields[current] += `\n${line}`;
    else if (line.trim()) refuse();
  }
  if (REPORT_FIELDS.some(field => !Object.hasOwn(fields, field) || !fields[field].trim())) refuse();
  const report = Object.fromEntries(REPORT_FIELDS.map(field => [field, fields[field].trim()]));
  if (!["done", "blocked", "question"].includes(report.STATUS)) refuse();
  return report;
}
