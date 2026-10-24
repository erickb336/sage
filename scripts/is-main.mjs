// The main guard of the scripts that are also modules (graphics.mjs, board-shots.mjs).
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";

/** True when the module at `url` is the script that node runs. It compares real paths, so that a run through a link
 *  (/tmp on macOS) counts. A script on standard input (node -) has no file, so no module is its main. */
export function isMain(url) {
  try { return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(url)); } catch { return false; }
}
