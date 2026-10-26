#!/usr/bin/env node
// The lead's wait (T482): node wait.mjs <T>, in the project's folder. It waits up to 9 minutes for a helper of the task's
// running lead run to stop, then prints each helper that stopped with its kept RESULT (sage-hook.mjs, waitForHelpers).
// It needs only Bash, so a lead waits for its helpers without the Monitor tool or a notice. It writes only a note that it
// named a report that the hook cannot read, so that it names that report once (T523).
import { waitForHelpers } from "./sage-hook.mjs";

const ms = Number(process.env.SAGE_WAIT_MS) > 0 ? Number(process.env.SAGE_WAIT_MS) : undefined; // tests only: a shorter wait
process.stdout.write(`${await waitForHelpers(process.argv[2], process.cwd(), { ms })}\n`);
