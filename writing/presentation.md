---
id: presentation
name: Present to the owner
applyWhen: every message that the chief sends to the owner in sage mode: a progress note, a question, a report, a catch-up, a design, and the other kinds below.
source: the owner's approved formats (the example pages of T984 and the settled catch-up, question and report, 11 Nov 2026), the text formats research (T998), the picture research (T999) and the display research (T1000)
---

Each message to the owner has one kind, and each kind has a fixed shape. The owner reads results after time away, often on a narrow screen. So a message names its kind first, says the news in its title, and ends with what you need. Write the text at 80% of Simplified Technical English, with sage's dictionary words.

## The cold-read test

Before you send a message, read it as the owner would after a week away, with no other context. Rewrite it until each answer is yes:

- Does the first line name the kind, and does the title say the news or the question?
- Does each part say one thing, fully, in words that a new reader knows? Say fewer things, each in full.
- Does the text name each piece of work by its name, not by an id? Ids go only in the Ref line.
- Does each time figure say agent time or human time, with its basis and a range?
- Is sample or simulated data labelled as such?
- Does the last part say what you need from the owner, or say "nothing"?

## Rules for every message

- **The first line** is the kind's head, for example `QUESTION` or `INCIDENT · Resolved`. The checks read the kind from it.
- **Where this is**: release › milestone or single task › step, for example "Release 1.0 › milestone 5, Sage feel › step: review". Leave out the release when the logbook has none.
- **State words**: a task, a milestone or a release is not started, waiting, needs you, in progress, done or stopped. Use these six words, not the tool's states.
- **One blank line** between the parts. A table becomes numbered rows, with one line for each column.
- **No raw ids** (a task, run, gate, milestone, chief, finding or pull request number) in the text or in a picture. Put them in one last line: `Ref: T12 · PR 40`.
- **Large choices only**: "Judged by" and "The bad side of my pick" go in a question only when the choice is large.

## Pictures

Draw each picture as fixed-width text first. The page draws its image from the same text, so the two cannot differ.

- At most 46 columns, or 66 on a long page. Only single-width characters. Known limit: a terminal with an East Asian wide setting draws box marks two columns wide.
- Boxes: rounded (╭ ╮ ╰ ╯) for a part, double (╔ ╗ ╚ ╝) for the part in focus, dashed (┄ ┆) for a group. Close every box: the checks name each box that does not close.
- Arrows: a line (│ ─) and one head (▼ ▲ ▶ ◀). Each arrow goes one way and has a label.
- No tree marks (├ └ ┬ ┴ ┼). Draw boxes inside boxes.
- Each picture has a title and a key. The key also names what the picture leaves out.
- An architecture picture shows one zoom, at most 6 boxes, and a [type] for each part. A state chart groups the states in dashed boxes, one for each state word. Both are usually pictures inside another kind.

## Pages

A message with a picture, and a message too long for the chat, get a page: one file in the task's pages folder that holds the whole message, with each picture as an image. The message names it in a Page block: `Page · <title>`, then its file path. In the Claude desktop app, the owner opens the path in the Browser pane. Do not send a page with Claude's file tool: it sends a copy through Anthropic's servers. A long message holds only its main point and the Page block; the page holds the rest.

A page loads nothing and runs only its own switch. Known limit: a page that the owner opens can still send its own content out through a link or a change of address.

## The message command

For a message with a picture, a long message, or any message where the shape matters, write it as JSON and let the state tool render it:

1. Write the JSON in your temp folder, for example `cat > /tmp/sage-message/T12.json <<'EOF'` … `EOF`.
2. Run `sage message <task> --file /tmp/sage-message/T12.json`. In Codex, call the `message` tool with the task and the message.
3. Send the text that it prints, word for word. It ends with the Page block when the message has a page.

The command refuses a message that is not in its kind's shape, and names each problem: fix them and run it again. Write a short message with no picture by hand, in the same shape: the checks read the text in the same way.

The JSON: `{ "kind", "title", "blocks": [ … ], "ref" }`, and `"status"` for an incident. A long message adds `"long": { "title", "main" }`: the title and the main point for the chat. Each block has its type in `t`:

| Block | Fields | Text form |
| --- | --- | --- |
| `field` | `label`, `text` | `Label: text` |
| `p` | `text` | a paragraph, anywhere |
| `section` | `label`, `body` (blocks) | the label, then its blocks |
| `list` | `items`, `ordered` | `- item` or `1. item` |
| `table` | `head`, `rows`, `pick` (the row of your pick, from 0), `caption` | numbered rows; your pick says "(my pick)" |
| `picture` | `title`, `lines` or `frame`, `key` | the title, the lines in a fence, the key |
| `toggle` | `after`, `today`: each a list of `{ title, lines }` | the pictures after the change; the page adds a Today switch |
| `changes` | `rows` of `{ where, today, after, why }` | numbered rows; for changes without a screen |
| `steps` | `items` of `{ text, cmd, see }` | numbered steps, each command in a fence |
| `code` | `lines` | the lines in a fence |
| `page` | `title`, `task`, `file` (a page in that task's pages folder) | the Page block |

A catch-up's picture is a `frame`: boxes inside boxes that the command lays out and gives their state words. Each box is `{ "box": "release" | "milestone" | "task" | "group", "name", "items": [ boxes or lines of text ] }`. A task gives its recorded `state` (for example `"reviewing"`), and may give `waits` (what it waits for) and `needs` (the owner's question). A milestone may give its state (`"proposed"`); its word and a release's word come from their items. A group gives its `word`. Any box may give a `note` for its first line, and one box is `"here": true`: the double box.

In the text of a field, a list or a cell, `**bold**` and a code span show on the page; the chat text shows the words alone.

## The kinds

<!-- sage-core-message-kinds -->
