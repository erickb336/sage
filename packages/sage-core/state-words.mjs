const DOING = {
  __proto__: null,
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
const ENDS = { __proto__: null, merged: ["done", "Merged."], concluded: ["done", "The study ended."], abandoned: ["stopped", "Stopped for good."] };

export function taskWord(card) {
  const { state, waitLine = null } = card ?? {}, reasons = card?.reasons ?? [];
  if (ENDS[state]) return { word: ENDS[state][0], reason: ENDS[state][1] };
  if (!DOING[state]) return { word: null, reason: `The board cannot read the state "${state}".` };
  const chiefs = reasons.some(reason => reason.kind === "merge-refused") ? ["merge-refused", "checks-fail", "qa-fail"] : [];
  const owner = reasons.filter(reason => !chiefs.includes(reason.kind));
  if (owner.length) return { word: "needs you", reason: owner[0].text };
  if (waitLine && ["framed", "briefed"].includes(state)) return { word: "waiting", reason: waitLine.text };
  return { word: state === "framed" ? "not started" : "in progress", reason: reasons[0]?.text ?? DOING[state] };
}

const MILESTONE = {
  __proto__: null,
  proposed: ["needs you", "Its breakdown waits for your answer."],
  lost: ["needs you", "The logbook lost its breakdown gate. Ask the chief to repair it."],
  stuck: ["needs you", "Its pilot stopped. Choose a new pilot, or drop the milestone."],
  changing: ["in progress", "You asked for changes. The chief revises the breakdown."],
  dropped: ["stopped", "You dropped it."],
};

export function milestoneWord({ state }, words = []) {
  return MILESTONE[state] ? { word: MILESTONE[state][0], reason: MILESTONE[state][1] } : releaseWord(words);
}

export function releaseWord(words = []) {
  const done = words.filter(word => word === "done").length, stopped = words.filter(word => word === "stopped").length;
  const count = `${done} of ${words.length} done.`;
  if (!words.length) return { word: "not started", reason: "Nothing is in it yet." };
  if (stopped === words.length) return { word: "stopped", reason: "Each item is stopped." };
  if (done + stopped === words.length) return { word: "done", reason: count };
  if (words.every(word => word === "not started" || word === "waiting")) return { word: "not started", reason: "Nothing in it has started." };
  return { word: "in progress", reason: count };
}
