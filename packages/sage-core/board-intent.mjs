// Board phrases in text that the caller already identified as the owner's own text.
// This parser recognizes a request. It does not establish who sent the text.
const SP = String.raw`[^\S\r\n\u2028\u2029]`;
const START = String.raw`^\s*[*_]{0,3}`;
const END = String.raw`(?:[?？][!.！。]?[*_]{0,3}${SP}*(?=[\r\n\u2028\u2029]|$)|[*_]{0,3}(?=${SP}*(?:[.,:;!！。\r\n\u2028\u2029]|$)))`;
const WORD = String.raw`[\p{L}\p{N}](?:[\p{L}\p{N}_.-]{0,62}[\p{L}\p{N}_-])?`;
// A task number is a bounded literal, never an argument assembled from arbitrary text.
const TASK = new RegExp(`${START}(?:(?:show|sage)${SP}+)?board${SP}+(T[1-9][0-9]{0,11})${END}`, "iu");
const BOARD = new RegExp(`${START}(?:show|sage)${SP}+board(?:${SP}+for${SP}+(${WORD}(?:${SP}+${WORD}){0,7}))?${END}`, "iu");
const STATUS = new RegExp(`${START}(?:show|sage)${SP}+status${END}`, "iu");
const FRAME = /<\/?(?:task-notification|agent-message|system-reminder)(?:\s|>)|\[Subagent hand-back\]|\[SYSTEM NOTIFICATION|Another Claude session sent a message:/i;

// The board phrases for the help list: each form that the patterns above match, with what it shows. A test parses each
// form, so the list cannot drift from the patterns. <project> and <task id> stand for a name and an id such as T197.
export const BOARD_PHRASES = [
  ["show board", "sage board", "the board of this project, and the address of the local board server"],
  ["show board for all", "sage board for all projects", "the board of every project"],
  ["show board for <project>", "sage board for <project>", "the board of one project"],
  ["show board <task id>", "board <task id>", "one task in full"],
  ["show status", "sage status", "the task states, the agents and what needs you"],
];

/**
 * @typedef {{kind: "board", scope: "this" | "all" | {project: string}} |
 *   {kind: "task", taskId: string} | {kind: "status"}} BoardIntent
 */

/** Returns a typed request, or null. The caller must verify the owner before dispatch.
 * @param {unknown} text
 * @returns {BoardIntent | null}
 */
export function parseBoardIntent(text) {
  if (typeof text !== "string" || FRAME.test(text)) return null;
  text = text.normalize("NFC");
  const task = TASK.exec(text);
  if (task) return { kind: "task", taskId: task[1].toUpperCase() };
  if (STATUS.test(text)) return { kind: "status" };
  const board = BOARD.exec(text);
  if (!board) return null;
  let project = board[1];
  // Underscores may be part of a name. Strip them only when they close a formatted phrase.
  const format = /^\s*(_{1,3})/.exec(text)?.[1];
  if (format && project?.endsWith(format)) project = project.slice(0, -format.length);
  if (!project) return { kind: "board", scope: "this" };
  project = project.normalize("NFC");
  const special = project.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  if (["this", "this-project"].includes(special)) return { kind: "board", scope: "this" };
  if (["all", "all-projects"].includes(special)) return { kind: "board", scope: "all" };
  return { kind: "board", scope: { project } };
}
