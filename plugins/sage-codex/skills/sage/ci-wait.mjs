#!/usr/bin/env node
import { realpathSync } from "node:fs";
import { waitForCi } from "../../core/index.mjs";
import { tool } from "./sage.mjs";

const ms = Number(process.env.SAGE_WAIT_MS) > 0 ? Number(process.env.SAGE_WAIT_MS) : undefined;
const [task, ...more] = process.argv.slice(2);
process.stdout.write(`${!more.length && /^T[1-9]\d*$/.test(task ?? "") ? await waitForCi(tool, realpathSync.native(process.cwd()), task, { ms })
  : "usage: node ci-wait.mjs <T>, with the project's folder as the working folder, for example node ci-wait.mjs T12"}\n`);
