# Principles

Short working principles for coding agents. The plugin's principles are these files: `npm run build` makes one skill from each.

## The files

- There is one file for each principle: `<id>.md`.
- The frontmatter has these fields:
  - `id`: the file name;
  - `name`;
  - `applyWhen`: one line;
  - `source`: the credit. For a principle from pstack, it names the pstack commit that the text comes from.
- The body is 200 words or fewer. It gives the rule, when it applies, when it does not, and when to stop.

## Credit

All principles here except one come from pstack, by Lauren Tan (MIT), at [github.com/cursor/plugins](https://github.com/cursor/plugins). The table on the [principles page](../docs/guide/principles.md) lists them. The licence is in [LICENSE-pstack](LICENSE-pstack). Each file's `source` names the original. The texts are shortened and rewritten, and some change the meaning on purpose, for example with a Stop rule. sage keeps its own text and does not follow later pstack changes.

"Contextualize and write for the reader" is this kit's own.

Thank you to Lauren Tan for pstack. Its principles inspired this collection.
