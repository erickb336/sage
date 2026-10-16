// Part 2 of the hook tests in scripts/sage-hook-tests.mjs: node runs the parts in parallel (F-T289-53).
globalThis.SAGE_HOOK_PART = 2;
await import("./sage-hook-tests.mjs");
