# Sage board service

The Sage board shows recorded tasks from explicit Claude and Codex logbook roots, and from the shared root that both providers use for a shared project. It reads them without changing them.

The service runs independently of a chat session. On the Mac itself, browser pages need no sign-in. Through a private HTTPS tunnel, they need one password that you set once in a terminal. Until you set it, access from outside the Mac is off. The board has no random secret. Chat and offline views use the same task model.

## Start locally

Use Node.js 20 or later. In Claude and in Codex, the board phrase does this for you: the chief runs `board --ensure` (in Codex, escalated, after your approval), which sets the board up when `~/.config/sage-board/board.json` is missing, starts the server in the background when nothing answers on its port, and prints the address or why the server is not running. The server log goes to `board.log` next to the config. The server writes its pid to `board.pid` there once it listens, and removes the file when it stops. Without `--config`, every board command uses that file; without `--sources`, setup uses the standard roots: `$SAGE_HOME` when it is set, or else `$CLAUDE_CONFIG_DIR/sage` or `~/.claude/sage`, and `$CODEX_HOME/sage` or `~/.codex/sage`, then the shared root: `$SAGE_SHARED_HOME`, `$SAGE_HOME/shared` or `~/.sage`. A root that does not exist shows as "not set up yet" until it appears. The shared root is the exception: until a project is shared, it is not there, and the board says nothing about it.

A config from before the shared root names only the Claude and Codex roots. The server and each board command add the shared root when they read, when no source of the config names its path, so a shared project shows without a new config. They do not change the config file.

The board reads a logbook again when it changed during the read: at most 3 times, each with its own share of the read limit. After the third change, the server keeps its last good read under the note "The logbook is changing", which is not a diagnostic, so the page is not stale. It reads again soon, and the next read with no change removes the note.

Each server sends a non-secret id of its config on the Mac, so `board --ensure` tells this config's board from an older board server or a board of another config on the same port, and says which. A server reads its config once, when it starts. After you change the config or the password, or update sage, `board --ensure` says that a restart is needed. A server keeps the code that it started with: after you update sage to the version that shows shared projects, stop the board with the command below, then ask for the board again. To restart, run:

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

Open the printed localhost URL. On the Mac itself (Host `127.0.0.1`, `localhost` or `[::1]` at the board's port, and no proxy header) the board needs no sign-in. Every other request signs in as `sage` with your board password.

Set the password yourself, in Terminal on the Mac:

```sh
node <path to board/cli.mjs> board --set-password
```

`board --ensure` and `board --setup` print this command with its full path. `board --setup` adds the `--config` that you gave it, so the command sets the password of that config. It asks twice with the echo off and needs 12 characters or more. The configuration file keeps only a salted scrypt hash. The command refuses when its input is not a terminal. Restart a running server after a change.

The terminal check accepts any pseudo-terminal, so it alone does not stop an agent. The sage hook in Claude Code adds a second barrier: it refuses the ordinary command shapes by which a session or an agent runs `--set-password`, or reads, copies or replaces the configuration file. An agent runs as your own user, so a script that builds the command or the path while it runs can still pass the hook. Full protection needs the sandbox (tasks T97 to T99).

Until you set a password, every request that is not from the Mac itself gets status 403 and the text "Access from outside this Mac is off until the owner sets a board password on the Mac." The text names no path; the exact command is only in the output of `board --ensure` on the Mac. A configuration from before this change can still have a random `secret`. It still loads, and a server of this version ignores it; `--set-password` removes it from the file. A server that started before the update can still take the secret, so `board --ensure` says that a restart is needed until you stop that server.

The default port is 43123. Setup accepts `--port` from 1024 to 65535. A busy port causes an error; the service does not choose another port.

Setup never changes a config that exists: it stops with an error that names the file. To change the port of an existing config, do these steps in this order:

1. Stop the board with `board --stop --config <file>`. Do this first: `--stop` looks for the board on the port that the file names.
2. Edit `"port"` in the file.
3. Ask for the board again, or run `board --ensure --config <file>`.

If you edit the port first, `--stop` finds no board on the new port, and the old server runs on. To set the board up again from the start, remove the file first; this also removes the board password.

The stable installation copies only board and core sources. It does not depend on a provider plugin cache. Stop the foreground service with Ctrl+C.

## The new board (preview)

The new board is at `/app/` on the same server: open `http://127.0.0.1:43123/app/` (or your configured port) in a desktop browser. It needs scripts. In this first version it has one page, the Overview, and it only reads the logbook:

- **Needs you:** each open question, oldest first, with its chief, its task, its recommendation and when it was asked. Answer each question in its chief's chat.
- **Milestones:** each milestone by the top priority of its open tasks, with its progress.
- **In the last 24 hours:** the tasks merged, and the runs that failed or whose agent is silent for 30 minutes. "New tasks" shows as not known, because the logbook keeps no time when a task is added.

The pages Tasks, Agents and Pull requests come next; until then, they link to the classic board at `/`. The new board loads only its own files from the board server, under a content security policy with no inline code and no outside source. Its data comes from one stream, `/app/events`. The classic board keeps working beside it.

## Other views

Use the same command with `--status` for short text, or without a format option for the chat board. A project name selects that project. `T197` selects a task in the current checkout. If two sources contain that task, add `--scope <source/project-key>` from the choices in the error.

Use `--html --out <absolute-path.html>` for an offline file. The command prints its path. The file contains the selected tasks and their details. Each default export gets a fresh filename. An explicit output path refuses to overwrite a file.

## Optional login startup

The install command creates a private launchd file but does not start a service. On macOS, stop the foreground board first. Start login service with `launchctl bootstrap "gui/$(id -u)" "$HOME/Library/LaunchAgents/dev.sage.board.plist"`.

Inspect it with `launchctl print "gui/$(id -u)/dev.sage.board"`. Stop it with `launchctl bootout "gui/$(id -u)/dev.sage.board"`. New login files use the current Node through its stable command on PATH. With Homebrew, the file keeps the bin alias instead of a version under Cellar. The installer checks that the alias names the running Node.

After a Node upgrade, inspect the login service with `launchctl print "gui/$(id -u)/dev.sage.board"`. Check its Node path, then open the board’s configured address. An older login file that names a Cellar version needs a new file with a stable Node path.

## Private phone access

The phone reaches the board only through a private HTTPS tunnel that forwards to `http://127.0.0.1:43123` and adds an `X-Forwarded-For` header. The board does not depend on one tunnel tool. One example is Tailscale Serve: `tailscale serve --bg --https=443 http://127.0.0.1:43123`. Another is a reverse proxy, such as Caddy or nginx, that you reach over a private network and that adds `X-Forwarded-For`.

1. Set the board password in a terminal (above).
2. Add the tunnel's exact host name to `allowedHosts` in the board configuration.
3. Restart the service with `board --stop` and `board --ensure`.
4. Open the tunnel's HTTPS address on the phone and sign in as `sage` with your board password.

Until `allowedHosts` names a host, the `board --ensure` line says that phone access is off. Until you set a password, it says that phone access is off and gives the set-password command.

A request that comes through the tunnel always needs the sign-in, also when it names a loopback host. The server treats a request as from the Mac only when it comes from loopback, names a loopback host, and has no header that a proxy adds (`X-Forwarded-*` or `Forwarded`). The server checks one password at a time and waits one second after a wrong one.

A raw TCP forward is not supported: it bypasses the sign-in. Such a forward (`ssh -L`, `socat`, `tailscale serve --tcp` or a similar tool) connects from loopback and adds no proxy header. So a request through it with a loopback Host gets the board with no sign-in. An SSH tunnel is a raw TCP forward of this kind.

Do not expose the tunnel to the public internet (for example Tailscale Funnel), and do not bind the board to a LAN address.

## Limits and verification

The board displays recorded facts. Missing provider, head, completion, or budget evidence stays unknown. Inferred PR counts remain separate from recorded running agents.

Claude owner phrases can request the board and task views. Codex uses the manual skill commands until native owner phrase delivery is verified. The service does not start agent orchestration or autopilot.

The server has four pages: the task board (`/`, with a page for each task at `/task/<id>`), the Releases tab (`/releases`, T996), the milestones list (`/milestones`, with a page for each milestone at `/milestone/<id>`) and the Agents page (`/agents`). Each page has its live stream (`/?events=1`, `/releases?events=1`, `/milestones?events=1`, `/milestone/<id>?events=1` and `/agents?events=1`), with the same sign-in. A task or milestone id in a route is the base64url of its key; an unknown milestone gives a not-found page with status 404. The Agents page also reads the hook's agent slots and helper notes under each logbook root (`.hooks/slots` and `.hooks/helpers`), by name and change time only. It refreshes by itself when an agent's state changes with time (30 min with no activity, or running long), as no file changes then.

The server also shows each task's pages folder, read-only, at `/pages/<logbook>/<task>/` (an index) and `/pages/<logbook>/<task>/<file>` (T1001). It serves these only to a request from the Mac itself, never through a tunnel.

It reads the raw path and never joins it onto a folder: it refuses `%`, `..`, a part that starts with a dot, any query but `?scripts=1`, a logbook that the board does not show, and a link or a file with a second name anywhere in the path. It serves only web pages, PDFs, pictures, and Markdown and text as plain text, at most 3 parts deep and 16 MiB.

Each page's response has a sandbox policy in place of the board's: the page has no origin, loads no picture, style or frame from a server, and runs only sage's own script (the switch of a message page); with `?scripts=1`, its own inline scripts also run, in the same sandbox. A script from a server does not run, but when its `integrity` hash matches the switch hash, the browser still requests it before it checks the hash (F-T1013-8); a blocked frame to another site still opens a connection that sends the host name (F-T1013-9). No policy stops a meta refresh in a page that runs scripts (`navigate-to` is not in Chromium), so a page with the switch gets scripts only when it has no `http-equiv` and no `srcdoc` outside sage's own policy tag, exactly as the message command writes it with core's `PAGE_POLICY`, and no UTF-16 byte order mark (F-T1013-1, F-T1013-2, F-T1013-6). The test fails closed: a tag that it cannot judge, for example one in a comment, costs the page its switch, and so does a message page from a sage with another page policy. The index runs no script and has no sandbox, so that its opener policy cuts the window handle of another site that opened it. A page cannot fetch the board, read its storage or send a form. A person's click on another site may open a page (a host app's chat may send its links so); a move that no person started, and `?scripts=1` from another site, get 403.

Limits of the pages route:

- A page can still send its own content out through a link that you click in it. A page opened with `?scripts=1` can also move itself to another site, by its script or by a meta refresh. Any other page runs no refresh.
- A page can also send content out with no click, also with no script: when it opens, Chromium sends the request of a prerender link (`<link rel="prerender">`, NoStatePrefetch) to any site, and the address can hold the page's content. No header that the board can send stops it: a probe in Chromium 140 tried CSP (`prefetch-src` and `navigate-to` too), Permissions-Policy, COOP, COEP, Vary and others (F-T1013-5). The request carries no referrer, but it carries the cookies of that site that `SameSite=Lax` lets through (F-T1013-10), and the page stays. Prefetch, preload, preconnect, DNS prefetch and speculation rules reached nothing in the same probe.
- On macOS, the board opens a page with no link in any folder of its path (`O_NOFOLLOW_ANY`). Other systems have no such flag, so there a folder that flips between a link and a folder during the board's checks can pass them.
- The Page link always names port 43123. A board on another port shows the pages there, but the link in a message does not reach them.
- The folder of the pages comes from `SAGE_WORKTREES`, or else `~/sage-worktrees`. A board that launchd starts gets no `SAGE_WORKTREES` from your shell, so it shows the pages under `~/sage-worktrees` only.

Local tests exercise the sign-in, file updates, task routes, the Agents page, reconnects, offline export, and stable installation. Phone access, login startup, and browser appearance still need direct checks.
