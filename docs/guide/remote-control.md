# Remote Control

This page tells you how to follow, steer and start your Claude Code sessions from the Claude app on your phone. Remote Control is a feature of Claude Code; sage's `remote-control` skill sets it up for you. It is for Claude Code only, and its server part runs on macOS only.

| Command | What it does |
| --- | --- |
| `/sage:remote-control` | Turns Remote Control on for every new session. |
| `/sage:remote-control off` | Turns it off. |
| `/sage:remote-control status` | Shows the setting. |
| `/sage:remote-control server ~/workspace` | Runs a Remote Control server in `~/workspace`, now and at each login (macOS). From the phone, you can then start sessions in that folder. |
| `/sage:remote-control server off` | Stops the server and removes its login item. |
| `/sage:remote-control server status` | Shows whether the phone can see the server ("Ready"). |

In the desktop app, also turn on **Settings → Claude Code → Connect new sessions to Remote Control**. Before the first `server`, do three things once, in the macOS Terminal app:

1. Log in. A `CLAUDE_CODE_OAUTH_TOKEN` from `claude setup-token` does not work for Remote Control.

   ```sh
   claude auth login
   ```

2. In the server's folder, start Claude Code, and answer Yes to the trust question.

   ```sh
   claude
   ```

3. In the same folder, run this command, answer `y` to "Enable Remote Control?", then press Ctrl+C. If your `~/.zshrc` sets `CLAUDE_CODE_OAUTH_TOKEN`, put `env -u CLAUDE_CODE_OAUTH_TOKEN` before it.

   ```sh
   claude remote-control
   ```

While the server runs, your claude.ai account can start sessions on your computer, and they can reach everything in the folder.

To use the board from the phone too, see [Private phone access](../../packages/sage-board/README.md#private-phone-access) in the board service guide.
