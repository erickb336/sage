<a href="docs/assets/hero-light.svg">
<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/assets/hero-dark.svg">
  <img alt="sage: your chief of staff for Claude Code. Send “sage mode” as a message. A hooded toad sage, the chief of staff, meditates in a misty mountain world. Around it, its team on a loop: designer, PE, implementer, arena judge, code reviewer, security reviewer, UX reviewer and QA." src="docs/assets/hero-light.svg" width="100%">
</picture>
</a>

**sage is a plugin for Claude Code (Codex support in progress) that turns a session into your chief of staff.**
You say what you want; a team of agents designs, builds, reviews and tests it, and you get a pull request with evidence.

<p align="center">
  <a href="https://github.com/erickb336/sage/actions/workflows/check.yml"><img alt="checks" src="https://github.com/erickb336/sage/actions/workflows/check.yml/badge.svg"></a>
  <a href="LICENSE"><img alt="licence" src="https://img.shields.io/github/license/erickb336/sage"></a>
</p>

**Status:** early. Claude Code: supported. Codex: in progress. See [Status](#status), the [Quick start](#quick-start), and one task from start to merge in [Learn sage in 5 minutes](docs/guide/learn-sage.md).

## Status

| Area | Status |
| --- | --- |
| Maturity | Early: used daily by its author to build sage itself; one recorded dry run. |
| Claude Code | Supported: sage mode, the team of agents, the rules in code, autopilot and the board. |
| Codex | In progress. Works: principles, writing skills, advice hooks, and the logbook and board by manual commands. Not yet: sage mode and autopilot. See [sage in Codex](docs/guide/codex.md). |
| Systems | macOS: tested. Linux: not yet tested. Windows: not supported. |

## Requirements

| You need | Claude Code | Codex |
| --- | --- | --- |
| The agent tool | Claude Code, with a Claude plan or API credits | Codex CLI 0.159.2 or later |
| Node.js 20 or later, and git | Yes | Yes |
| `gh`, logged in (`gh auth login`) | Yes: for pull requests and the merge check | No |
| A GitHub remote for your project | Recommended: without one, work stops at a verified branch | No |
| macOS | For the board server and Remote Control | For the board server |

## Quick start

For Claude Code. For Codex, see [sage in Codex](docs/guide/codex.md).

1. Install sage, in a terminal:

   ```sh
   claude plugin marketplace add erickb336/sage
   ```

   ```sh
   claude plugin install sage@sage
   ```

   You see `Successfully installed plugin: sage@sage (scope: user)`.
2. Start a new session in a project folder: run `claude`. A session that was already open does not get sage.
3. Send the on phrase as a message of its own, with no other words:

   ```text
   sage mode
   ```

   You see: the chief says that sage mode is on, and waits for your request.
4. Say what you want in the next message, for example `Fix the crash on an empty search.`

   You see: the chief frames the task, asks its product questions in one batch, then brings evidence and a pull request.

To update, run `claude plugin update sage@sage` and start a new session. To stop a task or uninstall sage, see [Using sage](docs/guide/using-sage.md).

## The board

Send `show board` to see what needs you, the agents at work, and each task in its column. On the Mac, it also starts the board page and gives its address.

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/assets/board-dark.png">
  <img alt="The board page with SAMPLE DATA: a project picker, a Needs you box, a filter bar, and six columns from Backlog to Done, with a card for each made-up task." src="docs/assets/board-light.png" width="100%">
</picture>

*Sample data: every task and program in the screenshot is made up. More in the [board guide](docs/guide/board.md).*

## What to say

Send each phrase alone, as the whole message.

| Say | What happens |
| --- | --- |
| `sage mode` | The session becomes your chief of staff. Send your request next. |
| `status` | Where each task is: running, waiting for you, verified. |
| `show board` | The board in the chat, and the address of the board page. |
| `autopilot on` / `autopilot off` | Verified pull requests merge by themselves, or wait for you again. Off by default. |
| `sage mode off` | A normal session again. Autopilot goes off too. |
| `sage help` | Every phrase, and whether sage mode and autopilot are on. |

All phrases and the exact rules: [Using sage](docs/guide/using-sage.md#the-switch-phrases).

## Safety and limits

| sage stops | sage does not stop |
| --- | --- |
| An agent that pushes to main, force-pushes or merges. | An agent that hides a command from the hook on purpose. A sandbox is planned. |
| A merge without its clean review cycles on that exact commit. | Anyone with your GitHub token who removes branch protection. |
| A mode switch by an agent's text: only your own message switches. | The cost of many agents: each one is a run on your plan or API credits. |

Every rule and its reason: [Rules held in code](docs/design/rules-in-code.md). Report a vulnerability: [SECURITY.md](SECURITY.md).

## What's new

> **Warning:** before you use waits or programs, update sage and restart every session that was already open. An older session still merges a waiting task, or a task of a program that you did not approve.

- **The board names more logbook problems:** a stuck program, a missing program and a logbook that it cannot read are items of Needs you.
- **The board page has a new look:** dark by default, with AA contrast in both themes.
- **Programs:** you approve the breakdown of a multi-task goal before any task of it builds.
- **A task can wait for other tasks**, and the board has an Agents page and a project picker.
- **A switch needs the exact phrase**, and `sage help` lists every phrase.

All changes: [CHANGELOG.md](CHANGELOG.md).

## Learn more

- [Learn sage in 5 minutes](docs/guide/learn-sage.md): one small task, from your first message to a merged pull request.
- [How sage works](docs/guide/how-it-works.md): the loops, the team, the routes and a task's life.
- [Using sage](docs/guide/using-sage.md): phrases, questions, update, stop, uninstall and troubleshooting.
- [Concepts](docs/guide/concepts.md), [principles](docs/guide/principles.md), and the [FAQ and credits](docs/guide/faq.md).
- [Contributing](CONTRIBUTING.md), and the [docs index](docs/README.md).

## Credits and licence

Built on [pstack](https://github.com/cursor/plugins/tree/main/pstack) and poteto mode by [Lauren Tan (poteto)](https://github.com/poteto). The name nods to Sage Mode in *Naruto*; the drawings are original ([all credits](docs/guide/faq.md#credits)).
MIT licence ([LICENSE](LICENSE)); pstack's text keeps [its MIT licence](upstream/pstack/LICENSE).
