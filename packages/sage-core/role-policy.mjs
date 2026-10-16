const TEAM = new Set(["implementer", "code-reviewer", "security-reviewer", "ux-reviewer", "qa"]);
const ROLES = new Set(["chief-of-staff", "lead", "pe", "designer", "arena-judge", ...TEAM]);

/** Role identity comes from the trusted adapter, not an agent's name or message. */
export function parseRolePlan(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)
    || Object.keys(value).length !== 2 || !Object.hasOwn(value, "issuerRole") || !Object.hasOwn(value, "role")
    || !ROLES.has(value.issuerRole) || !ROLES.has(value.role)) throw Error("Invalid role plan");
  return { issuerRole: value.issuerRole, role: value.role };
}

/** Evaluate inside the same transaction that consumes project and total capacity. */
export function checkRoleReservation(reservations, assignment, input) {
  const plan = parseRolePlan(input);
  if (plan.role === "chief-of-staff") throw Error("The chief is the owner session, not a child role");
  if (plan.issuerRole !== "chief-of-staff" && plan.issuerRole !== "lead") {
    throw Error("A specialist cannot start an agent; report to the chief");
  }
  if (plan.issuerRole === "lead" && !TEAM.has(plan.role)) throw Error("A lead can start only its permitted team");
  const project = reservations.filter(row => row.assignment.project === assignment.project);
  if (plan.role === "lead" && project.filter(row => !row.rolePlan || row.rolePlan.role === "lead").length >= 3) {
    throw Error("The project already holds three lead slots");
  }
  if (plan.issuerRole === "lead" && project.filter(row => row.assignment.session === assignment.session
    && row.assignment.epoch === assignment.epoch && row.assignment.issuer === assignment.issuer).length >= 3) {
    throw Error("The lead already holds three child slots");
  }
  return plan;
}

/** Providers supply verified mode and role. Null names an unmanaged actor. */
export function roleEditDenied({ sage, role }) {
  if (typeof sage !== "boolean" || (role !== null && !ROLES.has(role)) || (sage && role === null))
    throw Error("Invalid role edit context");
  return sage && !["implementer", "designer", "arena-judge"].includes(role);
}

/** New reservations enforce ownership; historical records retain their original rules. */
export function checkLeadOwnership(state, active, assignment, plan, continuingLead) {
  if (plan.role !== "lead") return;
  // Admission supplies this identity only after checking a completed predecessor.
  const ownTeam = row => continuingLead && row.rolePlan?.issuerRole === "lead"
    && row.assignment.issuer === continuingLead && row.assignment.session === assignment.session
    && row.assignment.epoch === assignment.epoch;
  const occupied = active.filter(row => row.assignment.project === assignment.project).some(row => {
    if (ownTeam(row)) return false;
    if (row.assignment.task === assignment.task
      && (!row.rolePlan || row.rolePlan.role === "lead" || row.rolePlan.issuerRole === "lead")) return true;
    if (row.rolePlan?.issuerRole !== "lead") return false;
    return state.bindings.some(binding => binding.project === row.assignment.project
      && binding.session === row.assignment.session && binding.epoch === row.assignment.epoch
      && binding.child === row.assignment.issuer && state.reservations.some(lead =>
        lead.assignment.id === binding.assignment && lead.rolePlan?.role === "lead"
        && lead.assignment.task === assignment.task));
  });
  if (occupied) throw Error("The task already has an active lead or team");
}
