# Sage board service

The Sage board shows recorded tasks from explicit Claude and Codex logbook roots. It reads them without changing them.

The service runs independently of a chat session. On the Mac itself, browser pages need no sign-in; through an allowed host, such as the Tailscale name, they do. Chat and offline views use the same task model.

## Start locally

Use Node.js 20 or later. In Claude, the board phrase does this for you: the chief runs `board --ensure`, which sets the board up when `~/.config/sage-board/board.json` is missing, starts the server in the background when nothing answers on its port, and prints the address or why the server is not running. The server log goes to `board.log` next to the config. The server writes its pid to `board.pid` there once it listens, and removes the file when it stops. Without `--config`, every board command uses that file; without `--sources`, setup uses the standard roots: `$SAGE_HOME` when it is set, or else `$CLAUDE_CONFIG_DIR/sage` or `~/.claude/sage`, and `$CODEX_HOME/sage` or `~/.codex/sage`. A root that does not exist shows as "not set up yet" until it appears.

Each server sends a non-secret id of its config on the Mac, so `board --ensure` tells this config's board from an older board server or a board of another config on the same port, and says which. A server reads its config once, when it starts. After you change the config or the password, `board --ensure` says that a restart is needed. To restart, run:

```sh
node <path to board/cli.mjs> board --stop
```

Then ask for the board again (or run `board --ensure`). `--stop` stops only this config's board: it checks that the board on the port names this config and the pid in `board.pid`, sends that pid a stop signal, and waits until the port is free. A board that a login service started has no `board.pid`; stop it with `launchctl bootout` (below).

To set it up by hand, run these commands from the Sage checkout, or from the `board/` folder of an installed plugin. `board --ensure` does the first and the last step for you; the install step makes a copy that does not change when the plugin updates. Replace the source paths when your provider uses another root.

```sh
node packages/sage-board/cli.mjs board --setup --config "$HOME/.config/sage-board/board.json" --sources "[{\"id\":\"claude\",\"path\":\"$HOME/.claude/sage\"},{\"id\":\"codex\",\"path\":\"$HOME/.codex/sage\"}]" --pages "$HOME/.local/share/sage-board/pages"
node packages/sage-board/cli.mjs board --install --config "$HOME/.config/sage-board/board.json" --install-dir "$HOME/.local/share/sage-board/service" --login-file "$HOME/Library/LaunchAgents/dev.sage.board.plist"
node "$HOME/.local/share/sage-board/service/packages/sage-board/cli.mjs" board --serve --config "$HOME/.config/sage-board/board.json"
```

Open the printed localhost URL. On the Mac itself (Host `127.0.0.1`, `localhost` or `[::1]` at the board's port) the board needs no sign-in. Through an allowed host, such as the Tailscale name, sign in as `sage` with your board password. Set it in a terminal with `board --set-password`: it asks twice with the echo off, needs 12 characters or more, and keeps only a salted scrypt hash in the configuration file, in place of the random `secret`. Until you set one, the password is the `secret` value from the private configuration file. Restart a running server after a change. Keep that file private.

The default port is 43123. Setup accepts `--port` from 1024 to 65535. A busy port causes an error; the service does not choose another port.

The stable installation copies only board and core sources. It does not depend on a provider plugin cache. Stop the foreground service with Ctrl+C.

## Other views

Use the same command with `--status` for short text, or without a format option for the chat board. A project name selects that project. `T197` selects a task in the current checkout. If two sources contain that task, add `--scope <source/project-key>` from the choices in the error.

Use `--html --out <absolute-path.html>` for an offline file. The command prints its path. The file contains the selected tasks and their details. Each default export gets a fresh filename. An explicit output path refuses to overwrite a file.

## Optional login startup

The install command creates a private launchd file but does not start a service. On macOS, stop the foreground board first. Start login service with `launchctl bootstrap "gui/$(id -u)" "$HOME/Library/LaunchAgents/dev.sage.board.plist"`.

Inspect it with `launchctl print "gui/$(id -u)/dev.sage.board"`. Stop it with `launchctl bootout "gui/$(id -u)/dev.sage.board"`. Keep the installed Node executable available at the path recorded in the launchd file.

## Private phone access

Sign in to Tailscale on the Mac and phone. Add the Mac’s exact Tailscale DNS name to `allowedHosts` in the board configuration, then restart the service with `board --stop` and `board --ensure`. Until `allowedHosts` names a host, the `board --ensure` line says that phone access is off.

Forward HTTPS with `tailscale serve --bg --https=443 http://127.0.0.1:43123`. Open its printed HTTPS URL on the phone and use the board sign-in. A request that comes through `tailscale serve` always needs the sign-in, also when it names a loopback host: the server treats a request as from the Mac only when it comes from loopback, names a loopback host, and has no header that a proxy adds (`X-Forwarded-*`, `Forwarded` or `Tailscale-*`). The server checks one password at a time and waits one second after a wrong one.

Use `tailscale serve status` to inspect the forwarding rule. To stop this forwarding rule, use `tailscale serve --bg --https=443 off`.

Use [Tailscale Serve](https://tailscale.com/docs/reference/tailscale-cli/serve) for private tailnet access. Do not use Funnel or bind the board to a LAN address.

Allow about five minutes for these steps when both devices already have Tailscale set up. This is a planning estimate; installation and sign-in take extra time.

## Limits and verification

The board displays recorded facts. Missing provider, head, completion, or budget evidence stays unknown. Inferred PR counts remain separate from recorded running agents.

Claude owner phrases can request the board and task views. Codex uses the manual skill commands until native owner phrase delivery is verified. The service does not start agent orchestration or autopilot.

Local tests exercise authentication, file updates, task routes, reconnects, offline export, and stable installation. Phone access, login startup, and browser appearance still need direct checks.
