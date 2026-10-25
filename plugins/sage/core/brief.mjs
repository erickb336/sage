// Structured task instructions. Role and tool authority come from separate policy.
export const BRIEF_FIELDS = Object.freeze(["GOAL", "SCOPE", "CONTEXT", "DECISIONS", "ACCEPTANCE", "VERIFY", "BUDGET", "FORBIDDEN", "REPORT", "STANDING"]);
const LIMIT = 32 * 1024;

export function parseBrief(input) {
  if (!input || typeof input !== "object" || Array.isArray(input) || Object.keys(input).length !== BRIEF_FIELDS.length
    || BRIEF_FIELDS.some(field => !Object.hasOwn(input, field))) throw Error("A brief needs every required text field");
  const brief = Object.fromEntries(BRIEF_FIELDS.map(field => [field, input[field]]));
  for (const value of Object.values(brief)) {
    if (typeof value !== "string" || value.trim().length === 0 || value.includes("\0")) throw Error("A brief needs every required text field");
    if (value.length > LIMIT) throw Error("The encoded brief exceeds 32 KiB");
    if (Buffer.from(value, "utf8").toString("utf8") !== value) throw Error("A brief needs valid Unicode text");
  }
  if (Buffer.byteLength(JSON.stringify(brief), "utf8") > LIMIT) throw Error("The encoded brief exceeds 32 KiB");
  return brief;
}

/**
 * A field's first line: a line that is not indented, whose text after Markdown marks (*, _, #, |, >) is the field's
 * name followed by a colon ("FORBIDDEN: x", "**GOAL:** x"), by two spaces or a tab (the chief's template, "GOAL   x"),
 * or by nothing (renderBrief's form). So a line of another field that starts with a field's word and one space
 * ("FORBIDDEN words are flagged") is text (F-T471-9).
 */
const HEADER = new RegExp(`^[*_#|>]*[ \\t]*(${BRIEF_FIELDS.join("|")})(?:[*_]*:|[*_]*(?: {2,}|\\t)|[*_ \\t]*$)[*_ \\t]*(.*)$`);
/** A Markdown list item, as in the Claude brief check: a bullet (-, * or +) or a number (1. or 1)), then a space. */
const LIST_ITEM = /^[-*+][ \t]|^\d+[.)][ \t]/;
/** A code fence, as in the Claude brief check: three or more backticks or tildes, indented by at most three spaces. */
const FENCE = /^ {0,3}(`{3,}|~{3,})(.*)$/;

/**
 * The text of each field that a brief gives, by name. A field runs to the next field; a name given twice is text, and
 * so is a line in a list or a code block (the rule of the Claude brief check).
 */
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

/** The fields that a brief's text does not give, or gives with no text, in BRIEF_FIELDS order. */
export function missingBriefFields(text) {
  const given = briefSections(text);
  return BRIEF_FIELDS.filter(field => !given[field]);
}

export function renderBrief(input) {
  const brief = parseBrief(input);
  return BRIEF_FIELDS.map(field => `${field}\n${brief[field]}`).join("\n\n");
}
