import { closeSync, constants, fstatSync, lstatSync, openSync, readSync, realpathSync, statSync } from "node:fs";
import { join } from "node:path";
import { PAGE_MAX, pageType } from "./message.mjs";
import { TASK_ID } from "./milestone-rules.mjs";
import { LOGBOOK_FOLDER } from "./shared-root.mjs";
import { pagesFolder, worktreeRoot } from "./worktrees.mjs";

const OPEN = constants.O_RDONLY | constants.O_NONBLOCK | (process.platform === "darwin" ? 0x20000000 : constants.O_NOFOLLOW);

export function pageTaskFolder(logbook, task, env = process.env) {
  if (!LOGBOOK_FOLDER.test(String(logbook)) || !TASK_ID.test(String(task))) return null;
  try {
    const want = join(pagesFolder(logbook, { SAGE_WORKTREES: realpathSync(worktreeRoot(env)) }), task);
    return realpathSync(want) === want && lstatSync(want).isDirectory() ? want : null;
  } catch { return null; }
}

export function pageFile(folder, file, read = false) {
  if (!pageType(file)) return null;
  const want = join(folder, file);
  let fd;
  try {
    fd = openSync(want, OPEN);
    const opened = () => { const info = fstatSync(fd, { bigint: true }); return info.isFile() && info.nlink === 1n && info.size <= BigInt(PAGE_MAX) ? info : null; };
    const first = opened(), at = first && realpathSync(want) === want ? statSync(want, { bigint: true }) : null, last = at && opened();
    if (!last || at.dev !== last.dev || at.ino !== last.ino || last.ctimeNs !== first.ctimeNs) return null;
    const size = Number(last.size);
    if (!read) return { size };
    const bytes = Buffer.alloc(size);
    let got = 0, n;
    while (got < size && (n = readSync(fd, bytes, got, size - got, got)) > 0) got += n;
    return { size, bytes: bytes.subarray(0, got) };
  } catch { return null; } finally { if (fd !== undefined) closeSync(fd); }
}
