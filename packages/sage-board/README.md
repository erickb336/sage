# Sage board service

The Sage board shows recorded tasks from explicit Claude and Codex logbook roots. It reads them without changing them.

The service runs independently of a chat session. On the Mac itself, browser pages need no sign-in. Through a private HTTPS tunnel, they need one password that you set once in a terminal. Until you set it, access from outside the Mac is off. The board has no random secret. Chat and offline views use the same task model.

## Start locally

Use Node.js 20 or later. In Claude, the board phrase does this for you: the chief runs `board --ensure`, which sets the board up when `~/.config/sage-board/board.json` is missing, starts the server in the background when nothing answers on its port, and prints the address or why the server is not running. The server log goes to `board.log` next to the config. The server writes its pid to `board.pid` there once it listens, and removes the file when it stops. Without `--config`, every board command uses that file; without `--sources`, setup uses the standard roots: `$SAGE_HOME` when it is set, or else `$CLAUDE_CONFIG_DIR/sage` or `~/.claude/sage`, and `$CODEX_HOME/sage` or `~/.codex/sage`. A root that does not exist shows as "not set up yet" until it appears.

Each server sends a non-secret id of its config on the Mac, so `board --ensure` tells this config's board from an older board server or a board of another config on the same port, and says which. A server reads its config once, when it starts. After you change the config or the password, or update sage, `board --ensure` says that a restart is needed. To restart, run:

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

`board --ensure` and `board --setup` print this command with its full path. It asks twice with the echo off and needs 12 characters or more. The configuration file keeps only a salted scrypt hash. The command refuses when its input is not a terminal. Restart a running server after a change.

The terminal check accepts any pseudo-terminal, so it alone does not stop an agent. The sage hook in Claude Code adds a second barrier: it refuses the ordinary command shapes by which a session or an agent runs `--set-password`, or reads, copies or replaces the configuration file. An agent runs as your own user, so a script that builds the command or the path while it runs can still pass the hook. Full protection needs the sandbox (tasks T97 to T99).

Until you set a password, every request that is not from the Mac itself gets status 403 and the text "Access from outside this Mac is off until the owner sets a board password on the Mac." The text names no path; the exact command is only in the output of `board --ensure` on the Mac. A configuration from before this change can still have a random `secret`. It still loads, and a server of this version ignores it; `--set-password` removes it from the file. A server that started before the update can still take the secret, so `board --ensure` says that a restart is needed until you stop that server.

The default port is 43123. Setup accepts `--port` from 1024 to 65535. A busy port causes an error; the service does not choose another port.

The stable installation copies only board and core sources. It does not depend on a provider plugin cache. Stop the foreground service with Ctrl+C.

## Other views

Use the same command with `--status` for short text, or without a format option for the chat board. A project name selects that project. `T197` selects a task in the current checkout. If two sources contain that task, add `--scope <source/project-key>` from the choices in the error.

Use `--html --out <absolute-path.html>` for an offline file. The command prints its path. The file contains the selected tasks and their details. Each default export gets a fresh filename. An explicit output path refuses to overwrite a file.

## Optional login startup

The install command creates a private launchd file but does not start a service. On macOS, stop the foreground board first. Start login service with `launchctl bootstrap "gui/$(id -u)" "$HOME/Library/LaunchAgents/dev.sage.board.plist"`.

Inspect it with `launchctl print "gui/$(id -u)/dev.sage.board"`. Stop it with `launchctl bootout "gui/$(id -u)/dev.sage.board"`. Keep the installed Node executable available at the path recorded in the launchd file.

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

Local tests exercise the sign-in, file updates, task routes, reconnects, offline export, and stable installation. Phone access, login startup, and browser appearance still need direct checks.
