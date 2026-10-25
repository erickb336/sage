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

/** A field's first line: its name at the start of a line, after spaces or marks such as - or **, as in the report check. */
const HEADER = new RegExp(`^[ \\t*_#|>-]*(${BRIEF_FIELDS.join("|")})\\b[*_]*:?[*_ \\t]*(.*)$`);

/** The text of each field that a brief gives, by name. A field runs to the next field; a name given twice is text. */
export function briefSections(text) {
  const fields = {};
  let field;
  for (const line of String(text).split(/\r?\n/)) {
    const match = HEADER.exec(line);
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
