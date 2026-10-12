import { isAbsolute } from "node:path";
import { readdirSync } from "node:fs";
import { programsRun } from "./command-reader.mjs";
import { commandWrites } from "./shell-write-policy.mjs";
import { fileWriteOutsideRoots } from "./protected-paths.mjs";

// Bounded '*'/'?' matching without a backtracking regular expression.
function simpleGlob(pattern, name) {
  // Unicode normalization and shell locale can change character boundaries. Inspect these names conservatively.
  if (/[^\x00-\x7f]/.test(pattern + name)) return true;
  let p = 0, n = 0, star = -1, retry = 0;
  while (n < name.length) {
    if (pattern[p] === "?" || pattern[p] === name[n]) { p++; n++; }
    else if (pattern[p] === "*") { star = p++; retry = n; }
    else if (star >= 0) { p = star + 1; n = ++retry; }
    else return false;
  }
  while (pattern[p] === "*") p++;
  return p === pattern.length;
}

/** Conservative path evidence for write forms. False is protected or unresolved, never permission. */
export function shellWriteOutsideRoots({ command, cwd, roots }) {
  // Validate the trusted context even when this command has no known write form.
  fileWriteOutsideRoots({ paths: [], cwd, roots });
  // Validation requires own data entries. Do not reuse caller-supplied methods.
  const fixedRoots = [];
  for (let index = 0; index < roots.length; index++) fixedRoots.push(roots[index]);
  roots = fixedRoots;
  if (typeof command !== "string" || command.length > 1024 * 1024) return false;
  if (!commandWrites(command, cwd)) return true;
  try {
    const evidence = programsRun(command, cwd, undefined, { contextEvidence: true, redirectEvidence: true });
    const check = (word, dir) => {
      if (typeof word !== "string" || word.length > 4096 || typeof dir !== "string" || !isAbsolute(dir)) return false;
      // This check does not expand runtime values, complex globs, or home-directory syntax.
      if (/[$`[{}~]|\p{Cc}/u.test(word)) return false;
      // Preserve literal '=' in file names. An option or assignment also carries a value.
      const equals = word.indexOf("=");
      if (equals >= 0 && /^(?:[A-Za-z_][A-Za-z0-9_]*|--?[A-Za-z][A-Za-z0-9-]*)$/.test(word.slice(0, equals))
        && !check(word.slice(equals + 1), dir)) return false;
      const value = word;
      if (!value) return true;
      // A short option can carry a path without '='. Consider every letter prefix;
      // this intentionally refuses ambiguous options that could name a protected alias.
      if (/^-[A-Za-z]/.test(value)) {
        const letters = /^-([A-Za-z]+)/.exec(value)[1];
        if (letters.length > 64) return false;
        for (let cut = 2; cut <= letters.length + 1 && cut < value.length; cut++)
          if (!check(value.slice(cut), dir)) return false;
      }
      // Interpreter bodies can name a protected path inside otherwise non-path text.
      const folded = value.normalize("NFKC").toLowerCase();
      if (roots.some(root => folded.includes(root.normalize("NFKC").toLowerCase()))) return false;
      if (/[?*]/.test(value)) {
        const slash = value.lastIndexOf("/"), folder = slash < 0 ? "." : value.slice(0, slash) || "/", pattern = value.slice(slash + 1);
        if (/[?*]/.test(folder) || pattern.length > 255 || (pattern.match(/[?*]/g) ?? []).length > 8) return false;
        if (!fileWriteOutsideRoots({ paths: [folder], cwd: dir, roots })) return false;
        const absolute = isAbsolute(folder) ? folder : `${dir}/${folder}`;
        let entries;
        try { entries = readdirSync(absolute, { withFileTypes: true }); }
        catch (error) { if (["ENOENT", "ENOTDIR"].includes(error.code)) return true; throw error; }
        if (entries.length > 4096) return false;
        return entries.filter(entry => simpleGlob(pattern, entry.name)).every(entry =>
          fileWriteOutsideRoots({ paths: [`${folder}/${entry.name}`], cwd: dir, roots }));
      }
      return fileWriteOutsideRoots({ paths: [value], cwd: dir, roots });
    };
    for (const entry of evidence.programs) {
      if (entry.uncertainDirectory) return false;
      const { run } = entry;
      // These programs do not treat their ordinary arguments as write targets or execute them.
      const dataOnly = !entry.wrapper && !entry.shellFunction && !entry.resolvedDeclaration
        && /(?:^|\/)(?:echo|printf|jq)$/.test(run.word);
      const words = dataOnly ? [run.word] : [run.word, ...run.args];
      if (!words.every(word => check(word, run.dir))) return false;
      if ((run.stdin ?? []).some(body => !check(body, run.dir))) return false;
    }
    for (const entry of evidence.redirects) {
      const target = entry.redirect.replace(/^\d*[<>&|]+/, "");
      if (!check(target, entry.dir)) return false;
    }
    return true;
  } catch { return false; }
}
