import { readFileSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { Worker, isMainThread, parentPort, workerData } from "node:worker_threads";
import { createStateTool } from "../core/index.mjs";

const OWNER = [["gate", "answer"], ["gate", "undo"], ["gate", "give"], ["chief", "name"]];
const WRITE_MS = 30_000;
export const ownerCommand = argv => Array.isArray(argv) && argv.every(word => typeof word === "string") && OWNER.some(([cmd, sub]) => argv[0] === cmd && argv[1] === sub);

function checkouts(shared, folder) {
  let text;
  try { text = readFileSync(join(shared, "bindings.tsv"), "utf8"); } catch { return []; }
  const [head, ...lines] = text.split("\n"), cols = head.split("\t");
  return lines.map(line => Object.fromEntries(line.split("\t").map((cell, i) => [cols[i], cell]))).filter(row => row.folder === folder && row.root?.startsWith("/")).flatMap(row => {
    try { return [realpathSync(row.root)]; } catch { return []; }
  });
}

export function ownerWrite({ shared, folder, argv }, env = process.env) {
  if (!ownerCommand(argv)) return { code: 1, text: "The board sends only the owner's commands: gate answer, gate undo, gate give and chief name." };
  const settings = { ...env, SAGE_SHARED_HOME: shared };
  const tool = createStateTool({ defaultRoot: () => join(shared, ".board-has-no-provider-root") });
  const dir = join(shared, folder);
  const project = checkouts(shared, folder).find(root => { try { return tool.locate(root, settings).dir === dir; } catch { return false; } });
  if (!project) return { code: 1, text: `No checkout of this project is on this Mac, so the board cannot write its logbook. Answer in the chief's chat.` };
  return tool.command([...argv, "--project", project], settings);
}

export function writeInWorker(job, { timeout = WRITE_MS } = {}) {
  return new Promise(done => {
    const worker = new Worker(new URL(import.meta.url), { workerData: { write: job } });
    const timer = setTimeout(() => done({ code: 2, pending: true, text: "Not confirmed yet: the logbook was busy. The write may still finish: reload the board to see it before you try again." }), timeout);
    worker.once("message", result => { clearTimeout(timer); done(result); });
    worker.once("error", error => { clearTimeout(timer); done({ code: 2, text: `The logbook write failed: ${error.message}` }); });
    worker.once("exit", () => { clearTimeout(timer); done({ code: 2, text: "The logbook write stopped before it answered." }); });
  });
}

if (!isMainThread && workerData?.write) parentPort.postMessage(ownerWrite(workerData.write));
