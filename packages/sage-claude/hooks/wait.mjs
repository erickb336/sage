#!/usr/bin/env node
// The lead's wait (T482): node wait.mjs <T>, in the project's folder. It waits up to 9 minutes for a helper of the task's
// running lead run to stop, then prints each helper that stopped with its kept RESULT (sage-hook.mjs, waitForHelpers).
// It needs only Bash, so a lead waits for its helpers without the Monitor tool or a notice. It writes only a note that it
// named a report that the hook cannot read, so that it names that report once (T523).
// node wait.mjs <T> --ci waits up to 9 minutes for CI on the head of the task's branch, with core's CI wait (T803).
import { realpathSync } from "node:fs";
import { waitForCi } from "sage-core";
import * as tool from "../skills/sage/sage.mjs";
import { waitForHelpers } from "./sage-hook.mjs";

const ms = Number(process.env.SAGE_WAIT_MS) > 0 ? Number(process.env.SAGE_WAIT_MS) : undefined; // tests only: a shorter wait
const [task, ci, ...more] = process.argv.slice(2);
const text = ci === undefined ? await waitForHelpers(task, process.cwd(), { ms })
  : ci === "--ci" && !more.length && /^T[1-9]\d*$/.test(task ?? "") ? await waitForCi(tool, realpathSync.native(process.cwd()), task, { ms })
  : "usage: node wait.mjs <T> [--ci], in the project's folder, for example node wait.mjs T12 --ci";
process.stdout.write(`${text}\n`);
