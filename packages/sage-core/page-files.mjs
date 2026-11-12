// T1001: which files of a logbook's pages the board serves. The board's pages route, its task index and the state tool's
// message command each ask these two functions, so that a link that the command prints or the index lists always opens.
import { closeSync, constants, fstatSync, lstatSync, openSync, readSync, realpathSync, statSync } from "node:fs";
import { join } from "node:path";
import { PAGE_MAX, pageType } from "./message.mjs";
import { TASK_ID } from "./milestone-rules.mjs";
import { LOGBOOK_FOLDER } from "./shared-root.mjs";
import { pagesFolder, worktreeRoot } from "./worktrees.mjs";

/**
 * The real folder of one task's pages (<worktree root>/<logbook>/pages/<task>), or null. The worktree root also holds
 * task checkouts and run folders, so only this folder is ever read: the logbook and the task have their own name rules,
 * and the logbook folder, its pages folder and the task folder must each be a folder, not a link. The root may be a link.
 */
export function pageTaskFolder(logbook, task, env = process.env) {
  if (!LOGBOOK_FOLDER.test(String(logbook)) || !TASK_ID.test(String(task))) return null;
  try {
    const want = join(pagesFolder(logbook, { SAGE_WORKTREES: realpathSync(worktreeRoot(env)) }), task);
    return realpathSync(want) === want && lstatSync(want).isDirectory() ? want : null;
  } catch { return null; }
}

/**
 * A file of a task's pages folder that the board serves, as { size } (and its bytes when read is true), or null. Its
 * name follows pageType. The open follows no link at the end and never waits (a named pipe), so the board must be able to
 * open it. It is a regular file with one name (a hard link could name any file of the owner's), of at most PAGE_MAX
 * bytes, and the file at its real path, so a link in any folder of the path is refused too. The checks of the opened
 * file hold before and after the path check, and its change time does not move between them: a name that is added or
 * removed during the checks (F-T1001-7) is refused.
 */
export function pageFile(folder, file, read = false) {
  if (!pageType(file)) return null;
  const want = join(folder, file);
  let fd;
  try {
    fd = openSync(want, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
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
