import { BRANCH } from "./branch.mjs";

export const REVIEW_ROLES = Object.freeze(["code-reviewer", "security-reviewer", "ux-reviewer", "qa"]);

/** Immutable review scope, separate from the report's claims and any accepted verdict. */
export function parseReviewTarget(value) {
  const keys = ["branch", "sha", "round", "cycle"];
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).length !== keys.length
    || keys.some(key => !Object.hasOwn(value, key)) || typeof value.branch !== "string" || !BRANCH.test(value.branch)
    || typeof value.sha !== "string" || !/^[0-9a-f]{40}$/.test(value.sha)
    || !Number.isSafeInteger(value.round) || value.round < 0
    || !Number.isInteger(value.cycle) || value.cycle < 1 || value.cycle > 10) throw Error("Invalid review target");
  return { branch: value.branch, sha: value.sha, round: value.round, cycle: value.cycle };
}

