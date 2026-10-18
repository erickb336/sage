// The fields that the owner sets for the board: per logbook, its display name and its archived flag (the logbook's own
// config.json); per task, its priority and its kind (two columns of tasks.tsv). The state tool writes them and the board
// reads them again, both with these rules, so the two never disagree.

/** The priorities of a task, most urgent first. An empty cell is no priority, and sorts last. */
export const PRIORITIES = ["P0", "P1", "P2", "P3"];
/** The kinds of a task: exactly one per task, from this fixed list (the T305 design). A new kind is a change of this list. */
export const TASK_KINDS = ["design", "ui", "orchestration", "optimization", "bug-fix", "logbook", "docs", "security", "providers", "checks"];
/** The most characters of a display name. */
export const NAME_MAX = 60;

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
 * Why a display name is refused, or null when it is good: 1 to 60 characters in the composed form (NFC), no space at an
 * end or two together, and no control, format, private-use, unassigned or hidden character.
 */
export function nameProblem(name) {
  if (typeof name !== "string") return "is not text";
  const length = [...name].length;
  if (!length || length > NAME_MAX) return `has ${length} characters: give 1 to ${NAME_MAX}`;
  if (name.normalize("NFC") !== name) return "is not in the composed Unicode form (NFC)";
  if (/^\s|\s$|\s\s/u.test(name)) return "has a space at its start or end, or two spaces together";
  if (/[\p{Cc}\p{Cf}\p{Co}\p{Cn}]/u.test(name) || name.replace(HIDDEN, "") !== name) return "has a control, format or hidden character (such as a tab, a line break, a zero-width space or a right-to-left mark)";
  return null;
}
