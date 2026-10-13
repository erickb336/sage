const refuse = () => { throw Error("Codex patch targets are unavailable"); };

/** Parse the supported direct patch form. Advice extraction is not authorization. */
export function patchTargets(patch) {
  if (typeof patch !== "string" || patch.length > 1024 * 1024) refuse();
  const lines = patch.replaceAll("\r\n", "\n").trim().split("\n");
  if (lines.shift() !== "*** Begin Patch" || lines.pop() !== "*** End Patch") refuse();
  const paths = [];
  let kind, body = false, moved = false;
  const target = value => {
    // Native Codex trims header endings. Refuse ambiguous targets before path checks.
    if (!value || value.length > 4096 || /\p{Cc}/u.test(value) || /\p{White_Space}$/u.test(value)) refuse();
    paths.push(value);
    if (paths.length > 4096) refuse();
  };
  for (const line of lines) {
    const header = /^\*\*\* (Add File|Update File|Delete File): (.+)$/.exec(line);
    if (header) { kind = header[1]; body = moved = false; target(header[2]); continue; }
    const move = /^\*\*\* Move to: (.+)$/.exec(line);
    if (move) {
      if (kind !== "Update File" || body || moved) refuse();
      moved = true; target(move[1]); continue;
    }
    if (kind === "Add File" && line.startsWith("+")) { body = true; continue; }
    if (kind === "Update File" && (line === "" || /^(?:@@(?: .*)?|[ +\-].*|\*\*\* End of File)$/.test(line))) {
      body = true; continue;
    }
    refuse();
  }
  return paths;
}
