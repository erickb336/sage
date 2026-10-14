# SDK validation boundary

This component addresses #94 by removing unused default-validator dependencies
from the Codex SDK bundle. It uses the SDK's public shim boundary instead of
changing published SDK code. It does not enable automatic Sage.

The build replaces the SDK's public `@modelcontextprotocol/server/_shims` module
with `sdk-shims.mjs`. The shim retains native Node process handling. It disables
the default JSON Schema validator; it does not disable Zod tool-input validation.

The validator can be constructed, so server startup still works. Every call to
`getValidator` throws the fixed unsupported-validation error. It never reports
that unvalidated data is valid.

This does not block all elicitation traffic. A form request can be sent before
response validation fails. URL elicitation does not use this validator.

The build checks esbuild's input graph and embedded source markers. It fails if
AJV, its excluded helpers, or fast-uri return. The check reads source inputs;
it does not patch minified output. `assertSdkBundleGraph` supports negative
controls with a supplied source reader.

No owner decision is needed. The packaged server tests must still verify valid
and invalid tool inputs and the unsupported-validation error after each upgrade.

This removes unused code; it does not upgrade fast-uri. Sage's hook and preparation
servers use Zod schemas and do not request elicitation. Installed automatic Sage
remains disabled for its separate activation gates.

The adaptation pins SDK 2.3.1. Its upstream build leaves the shim import external:
[build configuration](https://github.com/modelcontextprotocol/typescript-sdk/blob/fcef852f6cdafea07f36cf6fae69b37c8adf85be/packages/server/tsdown.config.ts).
The [Node shim](https://github.com/modelcontextprotocol/typescript-sdk/blob/fcef852f6cdafea07f36cf6fae69b37c8adf85be/packages/server/src/shimsNode.ts)
exports the validator and Node process. An SDK update must recheck this boundary.

The graph check rejects known excluded dependency paths and embedded source markers.
It is an offline check for this pinned bundle, not a live advisory database.
`npm audit` checks installed dependency metadata; it cannot see dependencies that
an SDK already embedded in published JavaScript. Review future SDK bundle inputs
and advisories before changing the pin.
