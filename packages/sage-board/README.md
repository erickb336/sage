# Sage board service

The Sage board shows recorded tasks from explicit Claude and Codex logbook roots, and from the shared root that both providers use for a shared project. It reads them without changing them.

The service runs independently of a chat session. It is for a desktop browser on this Mac only: it listens on 127.0.0.1, needs no sign-in, and refuses every request that does not come from the Mac itself. Chat and offline views use the same task model.

## Start locally

Use Node.js 20 or later. In Claude and in Codex, the board phrase does this for you: the chief runs `board --ensure` (in Codex, escalated, after your approval), which sets the board up when `~/.config/sage-board/board.json` is missing, starts the server in the background when nothing answers on its port, and prints the address or why the server is not running. The server log goes to `board.log` next to the config. The server writes its pid to `board.pid` there once it listens, and removes the file when it stops. Without `--config`, every board command uses that file; without `--sources`, setup uses the standard roots: `$SAGE_HOME` when it is set, or else `$CLAUDE_CONFIG_DIR/sage` or `~/.claude/sage`, and `$CODEX_HOME/sage` or `~/.codex/sage`, then the shared root: `$SAGE_SHARED_HOME`, `$SAGE_HOME/shared` or `~/.sage`. A root that does not exist shows as "not set up yet" until it appears. The shared root is the exception: until a project is shared, it is not there, and the board says nothing about it.

A config from before the shared root names only the Claude and Codex roots. The server and each board command add the shared root when they read, when no source of the config names its path, so a shared project shows without a new config. They do not change the config file.

The board reads a logbook again when it changed during the read: at most 3 times, each with its own share of the read limit. After the third change, the server keeps its last good read under the note "The logbook is changing", which is not a diagnostic, so the page is not stale. It reads again soon, and the next read with no change removes the note.

Each server sends a non-secret id of its config on the Mac, so `board --ensure` tells this config's board from an older board server or a board of another config on the same port, and says which. A server reads its config once, when it starts. After you change the config, or update sage, `board --ensure` says that a restart is needed. A server keeps the code that it started with: after you update sage to the version that shows shared projects, stop the board with the command below, then ask for the board again. To restart, run:

```sh
node <path to board/cli.mjs> board --stop
```

Then ask for the board again (or run `board --ensure`). `--stop` stops only this config's board: it checks that the board on the port names this config and the pid in `board.pid`, sends that pid a stop signal, and waits until the port is free. The login service runs the same `--serve` command, so its board writes `board.pid` too and `--stop` stops it; to stop the login service itself, use `launchctl bootout` (below).

An older board server, from before the board sent its id, does not name its process. `--stop` sends it no signal, whatever `board.pid` holds, and `board --ensure` says so. Stop it where it started: press Ctrl+C in its terminal, or run `launchctl bootout "gui/$(id -u)/dev.sage.board"` for the login service. Then ask for the board again.

To set it up by hand, run these commands in the `board/` folder of the installed plugin. `board --ensure` does the first and the last step for you; the install step makes a copy that does not change when the plugin updates. Replace the source paths when your provider uses another root.

```sh
node cli.mjs board --setup --config "$HOME/.config/sage-board/board.json" --sources "[{\"id\":\"claude\",\"path\":\"$HOME/.claude/sage\"},{\"id\":\"codex\",\"path\":\"$HOME/.codex/sage\"}]" --pages "$HOME/.local/share/sage-board/pages"
node cli.mjs board --install --config "$HOME/.config/sage-board/board.json" --install-dir "$HOME/.local/share/sage-board/service" --login-file "$HOME/Library/LaunchAgents/dev.sage.board.plist"
node "$HOME/.local/share/sage-board/service/packages/board/cli.mjs" board --serve --config "$HOME/.config/sage-board/board.json"
```

The last line runs the installed copy: use the path that the install step prints after "Installed board command". From the Sage checkout, run the same commands in `packages/sage-board/`; the installed copy is then `service/packages/sage-board/cli.mjs`.

Open the printed localhost URL in a desktop browser on the Mac. The board answers a request only when it comes from loopback, names a loopback host (`127.0.0.1`, `localhost` or `[::1]` at the board's port), and has no header that a proxy adds (`X-Forwarded-*` or `Forwarded`). Every other request is refused: status 403, or 404 on the pages route. The read routes take only GET and HEAD.

A config from an earlier version can still hold the keys `allowedHosts`, `password` or `secret`. It still loads, and the board ignores those keys. To remove them, edit the file, then restart the board.

The sage hook, in Claude Code and in Codex, refuses the ordinary command shapes by which a session or an agent reads, copies or replaces the configuration file, or lists, searches, copies or moves its folder. An agent runs as your own user, so a script that builds the path while it runs can still pass the hook. Full protection needs the sandbox (tasks T97 to T99).

The default port is 43123. Setup accepts `--port` from 1024 to 65535. A busy port causes an error; the service does not choose another port.

Setup never changes a config that exists: it stops with an error that names the file. To change the port of an existing config, do these steps in this order:

1. Stop the board with `board --stop --config <file>`. Do this first: `--stop` looks for the board on the port that the file names.
2. Edit `"port"` in the file.
3. Ask for the board again, or run `board --ensure --config <file>`.

If you edit the port first, `--stop` finds no board on the new port, and the old server runs on. To set the board up again from the start, remove the file first.

The stable installation copies only board and core sources. It does not depend on a provider plugin cache. Stop the foreground service with Ctrl+C.

## The new board (preview)

The new board is at `/app/` on the same server: open `http://127.0.0.1:43123/app/` (or your configured port) in a desktop browser. It needs scripts. Its Overview has:

- **The chiefs:** a chip for each chief of each shared project, with live, waits for you, stopped or not known, and the autopilot state. A click shows only that chief's work, on each page.
- **Needs you:** each open question, oldest first, with its chief, its task, its recommendation and when it was asked. A click opens the question with the message that the chief kept for it (`gates/G<n>.json`).
- **Answered · waits for the chief**, with Undo, and **Stopped chiefs**, with "Give to another chief" for each open task.
- **Milestones:** each milestone by the top priority of its open tasks, with its progress.
- **Since you looked** (or **In the last 24 hours** before your first visit): the tasks merged, the runs that failed or whose agent is silent for 30 minutes, and the tasks added. A task gets its added time from its `task added` decision row; a task from before this row shows no time.

**Writes.** A browser acts only after you pair it once: run `node cli.mjs board --pair` in Terminal (it refuses input that is not a terminal), and type the one-time code on the board. The server then sets the cookie `sage_board` (`HttpOnly; SameSite=Strict; Path=/`) and gives the page a second random secret, the token, which the page keeps in `localStorage`. The server keeps only the hashes of both in the board's state folder, `state/` next to the config, with `seen.json`, the time of your last visit. A browser sends its cookies to every port of `127.0.0.1`, but `localStorage` belongs to the board's own origin (its port too), so a server on another port that gets the cookie still has no token. Each `POST /api/...` must have the board's exact `Origin`, `Sec-Fetch-Site: same-origin`, a JSON body, the cookie and the token of the same browser in `X-Sage-Token`; an answer also carries the digest of the question that you saw. The server runs only `gate answer --via board`, `gate undo`, `gate give` and `chief name`, through the state tool in its own thread (Node's `worker_threads`), so the logbook lock never holds the server's event thread. It writes only a shared logbook, through a checkout of it on this Mac.

The pages Tasks, Agents and Pull requests come next; until then, they link to the classic board at `/`. The new board loads only its own files from the board server, under a content security policy with no inline code and no outside source. Its data comes from one stream, `/app/events`. The classic board keeps working beside it.

## Other views

Use the same command with `--status` for short text, or without a format option for the chat board. A project name selects that project. `T197` selects a task in the current checkout. If two sources contain that task, add `--scope <source/project-key>` from the choices in the error.

Use `--html --out <absolute-path.html>` for an offline file. The command prints its path. The file contains the selected tasks and their details. Each default export gets a fresh filename. An explicit output path refuses to overwrite a file.

## Optional login startup

The install command creates a private launchd file but does not start a service. On macOS, stop the foreground board first. Start login service with `launchctl bootstrap "gui/$(id -u)" "$HOME/Library/LaunchAgents/dev.sage.board.plist"`.

Inspect it with `launchctl print "gui/$(id -u)/dev.sage.board"`. Stop it with `launchctl bootout "gui/$(id -u)/dev.sage.board"`. New login files use the current Node through its stable command on PATH. With Homebrew, the file keeps the bin alias instead of a version under Cellar. The installer checks that the alias names the running Node.

After a Node upgrade, inspect the login service with `launchctl print "gui/$(id -u)/dev.sage.board"`. Check its Node path, then open the board’s configured address. An older login file that names a Cellar version needs a new file with a stable Node path.

## This Mac only

Do not forward the board's port to another computer (for example with `ssh -L`, `socat` or a reverse proxy), and do not bind the board to a LAN address. A raw TCP forward connects from loopback and adds no proxy header, so it passes the access check.

## Limits and verification

The board displays recorded facts. Missing provider, head, completion, or budget evidence stays unknown. Inferred PR counts remain separate from recorded running agents.

Claude owner phrases can request the board and task views. Codex uses the manual skill commands until native owner phrase delivery is verified. The service does not start agent orchestration or autopilot.

The server has four pages: the task board (`/`, with a page for each task at `/task/<id>`), the Releases tab (`/releases`, T996), the milestones list (`/milestones`, with a page for each milestone at `/milestone/<id>`) and the Agents page (`/agents`). Each page has its live stream (`/?events=1`, `/releases?events=1`, `/milestones?events=1`, `/milestone/<id>?events=1` and `/agents?events=1`), with the same access check. A task or milestone id in a route is the base64url of its key; an unknown milestone gives a not-found page with status 404. The Agents page also reads the hook's agent slots and helper notes under each logbook root (`.hooks/slots` and `.hooks/helpers`), by name and change time only. It refreshes by itself when an agent's state changes with time (30 min with no activity, or running long), as no file changes then.

The server also shows each task's pages folder, read-only, at `/pages/<logbook>/<task>/` (an index) and `/pages/<logbook>/<task>/<file>` (T1001). It serves these only to a request from the Mac itself.

It reads the raw path and never joins it onto a folder: it refuses `%`, `..`, a part that starts with a dot, any query but `?scripts=1`, a logbook that the board does not show, and a link or a file with a second name anywhere in the path. It serves only web pages, PDFs, pictures, and Markdown and text as plain text, at most 3 parts deep and 16 MiB.

Each page's response has a sandbox policy in place of the board's: the page has no origin, loads no picture, style or frame from a server, and runs only sage's own script (the switch of a message page); with `?scripts=1`, its own inline scripts also run, in the same sandbox. A script from a server does not run, but when its `integrity` hash matches the switch hash, the browser still requests it before it checks the hash (F-T1013-8); a blocked frame to another site still opens a connection that sends the host name (F-T1013-9). No policy stops a meta refresh in a page that runs scripts (`navigate-to` is not in Chromium), so a page with the switch gets scripts only when it has no `http-equiv` and no `srcdoc` outside sage's own policy tag, exactly as the message command writes it with core's `PAGE_POLICY`, and no UTF-16 byte order mark (F-T1013-1, F-T1013-2, F-T1013-6). The test fails closed: a tag that it cannot judge, for example one in a comment, costs the page its switch, and so does a message page from a sage with another page policy. The index runs no script and has no sandbox, so that its opener policy cuts the window handle of another site that opened it. A page cannot fetch the board, read its storage or send a form. A person's click on another site may open a page (a host app's chat may send its links so); a move that no person started, and `?scripts=1` from another site, get 403.

Limits of the pages route:

- A page can still send its own content out through a link that you click in it. A page opened with `?scripts=1` can also move itself to another site, by its script or by a meta refresh. Any other page runs no refresh.
- A page can also send content out with no click, also with no script: when it opens, Chromium sends the request of a prerender link (`<link rel="prerender">`, NoStatePrefetch) to any site, and the address can hold the page's content. No header that the board can send stops it: a probe in Chromium 140 tried CSP (`prefetch-src` and `navigate-to` too), Permissions-Policy, COOP, COEP, Vary and others (F-T1013-5). The request carries no referrer, but it carries the cookies of that site that `SameSite=Lax` lets through (F-T1013-10), and the page stays. Prefetch, preload, preconnect, DNS prefetch and speculation rules reached nothing in the same probe.
- On macOS, the board opens a page with no link in any folder of its path (`O_NOFOLLOW_ANY`). Other systems have no such flag, so there a folder that flips between a link and a folder during the board's checks can pass them.
- The Page link always names port 43123. A board on another port shows the pages there, but the link in a message does not reach them.
- The folder of the pages comes from `SAGE_WORKTREES`, or else `~/sage-worktrees`. A board that launchd starts gets no `SAGE_WORKTREES` from your shell, so it shows the pages under `~/sage-worktrees` only.

Local tests exercise the access check, file updates, task routes, the Agents page, reconnects, offline export, and stable installation. Login startup and browser appearance still need direct checks.
