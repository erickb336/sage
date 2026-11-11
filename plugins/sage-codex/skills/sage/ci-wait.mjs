#!/usr/bin/env node
// The lead's CI wait in Codex (T803): node ci-wait.mjs <T>, with the project's folder as the working folder. Core's CI wait
// (waitForCi) waits up to 9 minutes for CI on the head of the task's branch, with Codex's state tool, as Claude's
// node wait.mjs <T> --ci does with Claude's. It reads the logbook, the branch's head and two gh reads, and writes nothing.
import { realpathSync } from "node:fs";
import { waitForCi } from "../../core/index.mjs";
import { tool } from "./sage.mjs";

const ms = Number(process.env.SAGE_WAIT_MS) > 0 ? Number(process.env.SAGE_WAIT_MS) : undefined; // tests only: a shorter wait
const [task, ...more] = process.argv.slice(2);
process.stdout.write(`${!more.length && /^T[1-9]\d*$/.test(task ?? "") ? await waitForCi(tool, realpathSync.native(process.cwd()), task, { ms })
  : "usage: node ci-wait.mjs <T>, with the project's folder as the working folder, for example node ci-wait.mjs T12"}\n`);
