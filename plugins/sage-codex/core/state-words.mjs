// The six state words that the owner sees (T1002, the T995 design that the owner approved in gate G141): not started,
// waiting, needs you, in progress, done and stopped. One word for a task, a milestone and a release, each with a short
// reason that a board can show. Pure functions of the board model's cards and milestones: no file access, no display.
//
// One rule decides "needs you": the owner has a question to answer, or a merge to make, now. A task reads it from its
// card's reasons, the same reasons that put the card in the board's Needs you box (board-model.mjs), so the word and the
// box never decide it twice. Two cases of the design differ from today's box: a task that is done or stopped keeps its
// word (its gate shows alone in Needs you), and a merge check that refuses the head is the chief's to repair (F5).

/** What a task in each state is doing, as its reason says it when no reason needs you. */
const DOING = {
  framed: "No agent works on it yet.",
  designing: "Agents design it.",
  "awaiting-you": "You answered. The chief moves it on.",
  briefed: "The build starts next.",
  building: "Agents build it.",
  held: "Held. The chief moves it on.",
  reviewing: "Reviewers and QA check it.",
  repairing: "Agents fix the findings.",
  replan: "The chief makes a new plan.",
  verifying: "The last clean cycles run.",
  verified: "Every check is clean.",
  "pr-ready": "The pull request is ready to merge.",
};
const ENDS = { merged: ["done", "Merged."], concluded: ["done", "The study ended."], abandoned: ["stopped", "Stopped for good."] };

/**
 * A task's word, from its board card (buildBoardModel's tasks): state, reasons and waitLine. A state that the state tool
 * does not write has no word (null): the board shows its diagnostic instead.
 */
export function taskWord({ state, reasons = [], waitLine = null }) {
  if (ENDS[state]) return { word: ENDS[state][0], reason: ENDS[state][1] };
  if (!DOING[state]) return { word: null, reason: `The board cannot read the state "${state}".` };
  // F5: the chief repairs a refused head (a new commit, new cycles), so the refusal is the reason of a task in progress.
  const owner = reasons.filter(reason => reason.kind !== "merge-refused");
  if (owner.length) return { word: "needs you", reason: owner[0].text };
  // No agent can take a framed or briefed task before its waits are met (F1, F3). Design and PE may run meanwhile.
  if (waitLine && ["framed", "briefed"].includes(state)) return { word: "waiting", reason: waitLine.text };
  return { word: state === "framed" ? "not started" : "in progress", reason: reasons[0]?.text ?? DOING[state] };
}

/** A milestone's word in each state of the board's milestones that does not come from its tasks. */
const MILESTONE = {
  proposed: ["needs you", "Its breakdown waits for your answer."],
  lost: ["needs you", "The logbook lost its breakdown gate. Ask the chief to repair it."],
  stuck: ["needs you", "Its pilot stopped. Choose a new pilot, or drop the milestone."],
  changing: ["in progress", "You asked for changes. The chief revises the breakdown."],
  dropped: ["stopped", "You dropped it."],
};

/**
 * A milestone's word, from its state as the board model reads it (proposed, changing, active, done, stuck, dropped or
 * lost) and the words of its tasks. An active or done milestone's word comes from its tasks, as a release's does.
 */
export function milestoneWord({ state }, words) {
  return MILESTONE[state] ? { word: MILESTONE[state][0], reason: MILESTONE[state][1] } : releaseWord(words);
}

/**
 * A release's word, from the words of its items: its milestones, its single tasks, and a note of earlier work as one
 * done item. Empty, or nothing started: not started. Each item stopped: stopped (F6, so "done" never hides that nothing
 * shipped). Each item done or stopped: done. Else in progress.
 */
export function releaseWord(words) {
  const done = words.filter(word => word === "done").length, stopped = words.filter(word => word === "stopped").length;
  const count = `${done} of ${words.length} done.`;
  if (!words.length) return { word: "not started", reason: "Nothing is in it yet." };
  if (stopped === words.length) return { word: "stopped", reason: "Each item is stopped." };
  if (done + stopped === words.length) return { word: "done", reason: count };
  if (words.every(word => word === "not started" || word === "waiting")) return { word: "not started", reason: "Nothing in it has started." };
  return { word: "in progress", reason: count };
}
