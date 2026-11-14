import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { buildSync } from "esbuild";

export const APP_SOURCE = "packages/sage-board/app";
export const BUILT_NAME = /^(?:app|vendor|graph)-[A-Z0-9]{8}\.(?:js|css)$/;
export const BUDGET = { vendor: 256_000, script: 56_000, style: 22_500, graph: 218_000 };
const LICENCE_FILES = ["LICENSE", "LICENSE.md", "LICENSE.txt"];

export function budgetProblems(sizes, budget = BUDGET) {
  return Object.entries(sizes).filter(([part, bytes]) => bytes > budget[part])
    .map(([part, bytes]) => `the board app's ${part} file is ${bytes} bytes, over its budget of ${budget[part]} bytes (scripts/board-app.mjs): make it smaller, or raise the budget in the same change and say why`);
}

const packageOf = input => /(?:^|\/)node_modules\/((?:@[^/]+\/)?[^/]+)\//.exec(input)?.[1] ?? null;

export function buildBoardApp(root) {
  const result = buildSync({
    absWorkingDir: root,
    entryPoints: { app: `${APP_SOURCE}/main.jsx`, graph: `${APP_SOURCE}/graph.jsx`, "vendor-entry": `${APP_SOURCE}/vendor.js` },
    bundle: true, splitting: true, preserveSymlinks: true, format: "esm", platform: "browser", target: ["es2022"],
    minify: true, legalComments: "none", jsx: "automatic", charset: "utf8",
    define: { "process.env.NODE_ENV": "\"production\"" },
    entryNames: "[name]-[hash]", chunkNames: "vendor-[hash]", outdir: "out",
    write: false, metafile: true, logLevel: "silent",
  });
  const outputs = Object.entries(result.metafile.outputs).map(([path, meta]) => ({ name: path.slice("out/".length), meta, text: result.outputFiles.find(file => file.path.endsWith(`/${path}`)).text }));
  const script = outputs.find(item => item.meta.entryPoint === `${APP_SOURCE}/main.jsx`);
  const style = outputs.find(item => item.name === script.meta.cssBundle?.slice("out/".length));
  const graph = outputs.find(item => item.meta.entryPoint === `${APP_SOURCE}/graph.jsx`);
  const shared = outputs.filter(item => !item.meta.entryPoint && item.name.endsWith(".js")), vendor = shared[0];
  if (!script || !style || !graph || shared.length !== 1) throw new Error(`the board app build needs one script, one style, one graph file and one vendor file; if it makes two vendor files, graph.jsx reaches only part of the packages in ${APP_SOURCE}/vendor.js: import the others in graph.jsx too`);
  if (Object.keys(script.meta.inputs).some(packageOf)) throw new Error(`the board app's script bundles package code; import the package in ${APP_SOURCE}/vendor.js so that it goes into the vendor file`);
  const imports = (item, kind) => item.meta.imports.filter(entry => entry.kind === kind).map(entry => entry.path).join();
  if (imports(script, "import-statement") !== `out/${vendor.name}` || imports(script, "dynamic-import") !== `out/${graph.name}`) throw new Error("the board app's script must import only the vendor file, and load only the graph file on demand");
  if (graph.meta.imports.map(entry => entry.path).join() !== `out/${vendor.name}` || graph.meta.cssBundle) throw new Error("the board app's graph file must import only the vendor file, and no style");
  for (const item of [script, style, vendor, graph]) if (!BUILT_NAME.test(item.name)) throw new Error(`unexpected board app file name ${item.name}`);
  const problems = budgetProblems({ vendor: Buffer.byteLength(vendor.text), script: Buffer.byteLength(script.text), style: Buffer.byteLength(style.text), graph: Buffer.byteLength(graph.text) });
  if (problems.length) throw new Error(problems.join("; "));

  const pins = JSON.parse(readFileSync(join(root, "package.json"), "utf8")).devDependencies;
  const names = [...new Set([vendor, graph].flatMap(item => Object.keys(item.meta.inputs)).map(packageOf).filter(Boolean))].sort();
  const licences = new Map(names.map(name => {
    const dir = join(root, "node_modules", name), installed = JSON.parse(readFileSync(join(dir, "package.json"), "utf8")).version;
    if (pins[name] !== installed) throw new Error(`${name} ${installed} is in the board app, so package.json must pin it at exactly that version`);
    const file = LICENCE_FILES.map(entry => join(dir, entry)).find(existsSync);
    if (!file) throw new Error(`${name} has no licence file to ship with the board app`);
    return [`${name.replaceAll("/", "-")}.txt`, `${name} ${installed}\n\n${readFileSync(file, "utf8")}`];
  }));
  const manifest = { script: script.name, style: style.name, vendor: vendor.name, graph: graph.name };
  const files = new Map([[script.name, script.text], [style.name, style.text], [vendor.name, vendor.text], [graph.name, graph.text], ["manifest.json", `${JSON.stringify(manifest, null, 2)}\n`]]);
  return { files, licences, manifest };
}
