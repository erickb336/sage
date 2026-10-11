// Test only: expose the production preparation server inside the fresh native profile.
import { servePreparations } from "./plugin/runtime/preparation-server.mjs";
import { options } from "./sage-options.mjs";
servePreparations(options);
