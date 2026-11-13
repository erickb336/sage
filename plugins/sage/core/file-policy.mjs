export function chiefEditDenied({ sage, chief }) {
  if (typeof sage !== "boolean" || typeof chief !== "boolean") throw Error("Invalid edit policy context");
  return sage && chief;
}
