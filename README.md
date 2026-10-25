# sage

**sage is a Claude Code plugin for developers who want a team of agents to build, review and prove their work, while they review results instead of code.**
You say what you want in a session; the agents design, build, review and test it, and you get a pull request with evidence.

<p align="center">
  <a href="https://github.com/erickb336/sage/actions/workflows/check.yml"><img alt="checks" src="https://github.com/erickb336/sage/actions/workflows/check.yml/badge.svg"></a>
  <a href="LICENSE"><img alt="licence" src="https://img.shields.io/github/license/erickb336/sage"></a>
</p>

**Status:** early. Claude Code is supported, and Codex support is in progress ([Status](#status)).

Start with the [Quick start](#quick-start). Then follow one task from start to merge in [Learn sage in 5 minutes](docs/guide/learn-sage.md).

<a href="docs/assets/hero-light.svg">
<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/assets/hero-dark.svg">
  <img alt="sage: your chief of staff for Claude Code. To start, send the words sage mode as a message of its own, with no quote marks. A hooded toad sage, the chief of staff, meditates in a misty mountain world. Around it, its team on a loop: designer, PE (principal engineer), implementer, arena judge, code reviewer, security reviewer, UX reviewer and QA." src="docs/assets/hero-light.svg" width="100%">
</picture>
</a>

## Status

| Area | Status |
| --- | --- |
| Maturity | Early: used daily by its author to build sage itself; one recorded dry run. |
| Claude Code | Supported: sage mode, the team of agents, the rules in code, autopilot and the board. |
| Codex | In progress. The principles, the writing skills, the advice hooks, and the logbook and board by manual commands work; sage mode and autopilot do not work yet ([sage in Codex](docs/guide/codex.md)). |
| Systems | macOS: tested. Linux: not yet tested. Windows: not supported. |

## Requirements

| You need | Claude Code | Codex |
| --- | --- | --- |
| The agent tool | Claude Code, with a Claude plan or API credits | Codex CLI 0.159.2 or 0.160.0 |
| Node.js 20 or later, and git | Yes | Yes |
| `gh`, logged in (`gh auth login`) | Yes: for pull requests and the merge check | No |
| A GitHub remote for your project | Recommended: without one, work stops at a verified branch | No |
| macOS | For the board server and [Remote Control](docs/guide/remote-control.md) (sessions from your phone) | For the board server |

## Quick start

For Claude Code. For Codex, see [sage in Codex](docs/guide/codex.md). Claude Code must be installed and signed in ([install Claude Code](https://code.claude.com/docs/en/setup)).

1. Install sage, in a terminal:

   ```sh
   claude plugin marketplace add erickb336/sage
   ```

   ```sh
   claude plugin install sage@sage
   ```

   You see `Successfully installed plugin: sage@sage (scope: user)`.
2. Start a new session in a project folder: run `claude`. The first time, Claude Code asks you to trust the folder. A session that was already open does not get sage.
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
  <img alt="The top of the board page at phone width, with SAMPLE DATA: the project picker, the filter bar, a Needs you box, and the first card of the Backlog column, which asks you to approve a program." src="docs/assets/board-light.png" width="400">
</picture>

*Sample data: every task and program in the screenshot is made up. The screenshot shows only the top of the page: the project picker, the filters, the Needs you box and the first card of the first column. The [board guide](docs/guide/board.md) describes the full board.*

## What to say

Send each phrase alone, as the whole message.

| Say | What happens |
| --- | --- |
| `sage mode` | The session becomes your chief of staff. Send your request next. |
| `show status` | Where each task is: running, waiting for you, verified. |
| `show board` | The board in the chat, and the address of the board page. |
| `autopilot on` / `autopilot off` | Verified pull requests merge by themselves, or wait for you again. Off by default. |
| `sage mode off` | A normal session again, for the rest of the session. Autopilot goes off too. |
| `sage help` | Every phrase, and whether sage mode and autopilot are on. |

Every phrase, also the board forms, and the exact rules: [Every phrase](docs/guide/using-sage.md#every-phrase).

## Safety and limits

| sage stops | sage does not stop |
| --- | --- |
| An agent that pushes to main, force-pushes or merges. | An agent that hides a command from the hook on purpose. A sandbox is planned. |
| A merge without its clean review cycles on that exact commit. A task with no review or QA in its route needs only its checks to pass. | Anyone with your GitHub token who removes branch protection. |
| A mode turned on by an agent's text: only your own message turns a mode on. | The cost of many agents: each one is a run on your plan or API credits. |

Every rule and its reason: [Rules held in code](docs/design/rules-in-code.md). Report a vulnerability: [SECURITY.md](SECURITY.md).

## What's new

> **Warning:** before you use waits or programs, update sage and restart every session that was already open. An older session still merges a waiting task, or a task of a program that you did not approve.

- **The off phrase holds in every session**, also in a folder that starts every session in sage mode.
- **The board names more logbook problems:** a stuck program, a missing program and a logbook that it cannot read are items of Needs you.
- **The board page has a new look:** dark by default, with AA contrast in both themes.
- **Programs:** you approve the breakdown of a multi-task goal before any task of it builds.
- **A task can wait for other tasks**, and the board has an Agents page and a project picker.

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
