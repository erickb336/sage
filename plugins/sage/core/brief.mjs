export const BRIEF_FIELDS = Object.freeze(["GOAL", "SCOPE", "CONTEXT", "DECISIONS", "ACCEPTANCE", "VERIFY", "BUDGET", "FORBIDDEN", "REPORT", "STANDING"]);

const HEADER = new RegExp(`^[*_#|>]*[ \\t]*(${BRIEF_FIELDS.join("|")})(?:[*_]*:|[*_]*(?: {2,}|\\t)|[*_ \\t]*$)[*_ \\t]*(.*)$`);
const LIST_ITEM = /^[-*+][ \t]|^\d+[.)][ \t]/;
const FENCE = /^ {0,3}(`{3,}|~{3,})(.*)$/;

export function briefSections(text) {
  const fields = {};
  let field, fence;
  for (const line of String(text).split(/\r?\n/)) {
    const mark = FENCE.exec(line);
    const opens = !fence && mark && !(mark[1][0] === "`" && mark[2].includes("`"));
    const closes = fence && mark && mark[1][0] === fence[0] && mark[1].length >= fence.length && !mark[2].trim();
    const inCode = Boolean(fence || opens);
    if (opens) fence = mark[1];
    else if (closes) fence = undefined;
    const match = !inCode && !/^\s/.test(line) && !LIST_ITEM.test(line) && HEADER.exec(line);
    if (match && !Object.hasOwn(fields, match[1])) [field, fields[match[1]]] = [match[1], match[2]];
    else if (field) fields[field] += `\n${line}`;
  }
  return Object.fromEntries(Object.entries(fields).map(([name, value]) => [name, value.trim()]));
}

export function missingBriefFields(text) {
  const given = briefSections(text);
  return BRIEF_FIELDS.filter(field => !given[field]);
}

