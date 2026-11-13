#!/usr/bin/env node
import { realpathSync } from "node:fs";
import { waitForCi } from "../core/index.mjs";
import * as tool from "../skills/sage/sage.mjs";
import { waitForHelpers } from "./sage-hook.mjs";

const ms = Number(process.env.SAGE_WAIT_MS) > 0 ? Number(process.env.SAGE_WAIT_MS) : undefined;
const [task, ci, ...more] = process.argv.slice(2);
const text = ci === undefined ? await waitForHelpers(task, process.cwd(), { ms })
  : ci === "--ci" && !more.length && /^T[1-9]\d*$/.test(task ?? "") ? await waitForCi(tool, realpathSync.native(process.cwd()), task, { ms })
  : "usage: node wait.mjs <T> [--ci], in the project's folder, for example node wait.mjs T12 --ci";
process.stdout.write(`${text}\n`);
