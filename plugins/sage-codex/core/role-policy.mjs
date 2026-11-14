export const TEAM = new Set(["implementer", "code-reviewer", "security-reviewer", "ux-reviewer", "qa"]);
const ROLES = new Set(["chief-of-staff", "lead", "pe", "designer", "arena-judge", ...TEAM]);

const INVESTIGATION = new Set(["investigate", "evidence-review"]);

export function roleEditDenied({ sage, role }) {
  if (typeof sage !== "boolean" || (role !== null && !ROLES.has(role) && !INVESTIGATION.has(role)) || (sage && role === null))
    throw Error("Invalid role edit context");
  return sage && !["implementer", "designer", "arena-judge"].includes(role);
}
