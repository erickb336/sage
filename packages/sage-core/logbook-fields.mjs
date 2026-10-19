// The fields that the owner sets for the board: per logbook, its display name and its archived flag (the logbook's own
// config.json); per task, its priority and its kind (two columns of tasks.tsv). The state tool writes them and the board
// reads them again, both with these rules, so the two never disagree.

/** The priorities of a task, most urgent first. An empty cell is no priority, and sorts last. */
export const PRIORITIES = ["P0", "P1", "P2", "P3"];
/** The kinds of a task: exactly one per task, from this fixed list (the T305 design). A new kind is a change of this list. */
export const TASK_KINDS = ["design", "ui", "orchestration", "optimization", "bug-fix", "logbook", "docs", "security", "providers", "checks"];
/** The problem classes of a finding, which its reviewer tags (finding add --class, T346): a starter list for every project. */
export const FINDING_CLASSES = ["state-edge", "speed", "copy", "layout", "security", "other"];
/** The most characters of a display name. */
export const NAME_MAX = 60;

/** A decimal number, also with spaces around it, a sign, leading zeros, a fraction or an exponent: "03", " 2", "-1", "2.5". */
const NUMERIC = /^\s*[+-]?(\d+(\.\d*)?|\.\d+)(e[+-]?\d+)?\s*$/i;
/**
 * A config count, or undefined when the value has no number: a finite number, or a numeric string. It rounds up (up) or
 * down, then reads as floor when below it and as limit when above it. The state tool reads every count with this rule,
 * and the board reads the agent caps with it, so the two never disagree.
 */
export function countOf(value, { floor = 1, limit = 50, up = false } = {}) {
  const n = typeof value === "number" || (typeof value === "string" && NUMERIC.test(value)) ? Number(value) : NaN;
  return Number.isFinite(n) ? Math.min(Math.max(up ? Math.ceil(n) : Math.floor(n), floor), limit) : undefined;
}
/** The agent caps without a config: max_agents for each project (unless cap.<project> is set), cap_total for all. */
export const AGENT_CAPS = { max_agents: 4, cap_total: 12 };
/** The agent caps of a sage root's parsed config.json, as the hook applies them: cap(<project name>) and the total. */
export function agentCaps(config) {
  const c = config && typeof config === "object" && !Array.isArray(config) ? config : {};
  const max = countOf(c.max_agents) ?? AGENT_CAPS.max_agents;
  return { total: countOf(c.cap_total) ?? AGENT_CAPS.cap_total, cap: project => countOf(c[`cap.${project}`]) ?? max };
}

/**
 * The characters that a person does not see but a terminal or an agent acts on: the controls but tab and line feed (C0,
 * DEL and C1), the bidi embeddings, overrides, isolates and marks (U+202A-202E, U+2066-2069, U+200E, U+200F, U+061C), the
 * zero-width characters (U+200B-200D, U+2060, U+FEFF), the variation selectors (U+FE00-FE0F, U+E0100-E01EF) and the tag
 * characters (U+E0000-E007F, text that only an agent reads). A joiner or non-joiner (U+200C, U+200D) between two letters
 * stays, as Persian and Indic text needs it; a joiner between two emoji stays, so a joined emoji stays whole; the emoji
 * selector (U+FE0F) stays after an emoji or a keycap base. Other text, also emoji and every script, stays; a subdivision
 * flag shows as a black flag.
 */
export const HIDDEN = /[\0-\x08\x0b-\x1f\x7f-\x9f\u061c\u200b\u200e\u200f\u2060\ufeff\ufe00-\ufe0e\u202a-\u202e\u2066-\u2069\u{e0000}-\u{e007f}\u{e0100}-\u{e01ef}]|(?<![\p{Extended_Pictographic}0-9#*])\ufe0f|(?<![\p{L}\p{M}](?=[\u200c\u200d]\p{L})|[\p{Extended_Pictographic}\p{Emoji_Modifier}]\ufe0f?(?=\u200d\p{Extended_Pictographic}))[\u200c\u200d]/gu;
/**
 * The characters that show as nothing although Unicode gives them a visible class: the combining grapheme joiner (U+034F),
 * the Hangul fillers (U+115F, U+1160, U+3164, U+FFA0) and the braille blank (U+2800). Also the line and paragraph
 * separators (U+2028, U+2029), which break a line. A name refuses them as hidden characters.
 */
const BLANK = /[\u034f\u115f\u1160\u3164\uffa0\u2800\u2028\u2029]/u;
/** The most combining marks in a row: a longer run stacks marks over the text around it. */
const MARKS_MAX = 3;

/**
 * Why a display name is refused, or null when it is good: 1 to 60 characters in the composed form (NFC), no space at an
 * end or two together, no control, format, private-use, unassigned, blank or hidden character, at most 3 combining marks
 * in a row, and one visible character or more. A joiner or non-joiner stays where HIDDEN keeps it (between two letters,
 * or after an emoji before an emoji), so a Persian name or a joined emoji is good.
 */
export function nameProblem(name) {
  if (typeof name !== "string") return "is not text";
  const length = [...name].length;
  if (!length || length > NAME_MAX) return `has ${length} characters: give 1 to ${NAME_MAX}`;
  if (name.normalize("NFC") !== name) return "is not in the composed Unicode form (NFC)";
  if (/^\s|\s$|\s\s/u.test(name)) return "has a space at its start or end, or two spaces together";
  // HIDDEN removes each joiner that it does not keep: a joiner that is left after it is one that HIDDEN keeps.
  if (name.replace(HIDDEN, "") !== name || /[\p{Cc}\p{Co}\p{Cn}]|(?![\u200c\u200d])\p{Cf}/u.test(name) || BLANK.test(name)) return "has a control, format or hidden character (such as a tab, a line break, a zero-width space or a right-to-left mark)";
  if (new RegExp(`\\p{M}{${MARKS_MAX + 1}}`, "u").test(name)) return `has more than ${MARKS_MAX} combining marks in a row`;
  if (!/[\p{L}\p{N}\p{P}\p{S}]/u.test(name)) return "has no visible character";
  return null;
}

/**
 * The owner's settings of one logbook from its parsed config.json: its display name (null for none) and its archived
 * flag. A bad value falls back (no name; not archived) with a warning, so that a hand-edited file never stops the board.
 */
export function logbookSettings(config) {
  if (!config || typeof config !== "object" || Array.isArray(config)) return { name: null, archived: false, warnings: ["config: config is not an object"] };
  const why = config.name === undefined ? null : nameProblem(config.name);
  const warnings = [...(why ? [`config: the name ${why}`] : []), ...(config.archived !== undefined && typeof config.archived !== "boolean" ? ["config: archived is not true or false"] : [])];
  return { name: config.name === undefined || why ? null : config.name, archived: config.archived === true, warnings };
}
