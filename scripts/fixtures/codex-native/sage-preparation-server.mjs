// Test only: expose the production preparation server inside the fresh native profile.
import { serveConfiguredPreparations } from "./plugin/runtime/configuration.mjs";
import { join, dirname } from "node:path";
import { options } from "./sage-options.mjs";
serveConfiguredPreparations(join(dirname(options.directory), "sage-config.json"));
