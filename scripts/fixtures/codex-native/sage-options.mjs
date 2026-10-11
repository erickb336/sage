// Copied into a fresh native test profile, never loaded from an installed plugin.
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
const root = dirname(fileURLToPath(import.meta.url));
export const options = { directory: join(root, "admission"), project: "native-fixture",
  projectDirectory: join(root, "workspace"), sessionsDir: join(root, "codex/sessions"),
  observationsRoot: join(root, "observations") };
