# Web ssh 

Self-hosted web app and SSH proxy built as a usable mobile SSH client for iPadOS. The browser terminal uses [ghostty-web](https://github.com/coder/ghostty-web), a Ghostty WASM terminal emulator with canvas rendering, and connects to backend servers over WebSocket.


> Warning! i dont plan to secure this app in any way, because I rely on Cloudflare Tunnel and Zero Trust policies to enforce access control


# Hosting

The frontend is bundled with Bun. `ghostty-vt.wasm` is copied into `public/` during the client build and served alongside the JavaScript bundle.

## Configuration format (`config.json`):

```json
{
	"servers": [
		{
			"name": "custom name",
			"user": "ssh server user",
			"pass": "ssh server pass",
			"host": "ssh hostname",
			"last_tmux_session_path": "/home/antost/last_tmux_session"
		}
	]
}
```

## docker-compose.yml

```yaml
services:
  web-ssh:
    image: antost360/web-ssh:latest
    ports:
      - "3000:3000"
    volumes:
      - /opt/web-ssh/config.json:/app/config/config.json:ro
      - /Users/user/.ssh/known_hosts:/app/config/known_hosts:ro
```

Then:

```sh
docker compose up -d
```

Open http://localhost:3000 — the index page lists the servers from `config.json`.

## Notes

- these are the environment variables you can overwrite and their default values you should map volumes to:
    - `CONFIG_PATH` -> `/app/config/config.json`
    - `SSH_KNOWN_HOSTS` -> `/app/config/known_hosts`
- Known hosts must contain the ed25519 fingerprints of every target server (`HostKeyAlgorithms` is pinned to `ssh-ed25519`).
- There is no auth on the app itself — protect it with Cloudflare Tunnel + Zero Trust or another reverse proxy.

> overwriting with envs is useful for development when I run the program localy


## Auto-resume tmux session (optional)

Fully optional — skips if `last_tmux_session_path` is unset. This solves the
iPad PWA case: the browser tab may be backgrounded/swiped away and the server
never sees a clean disconnect, so "save on disconnect" logic is unreliable.
Instead, tracking happens *inside tmux on the remote*, and web-ssh just reads
the result on connect.

The idea (specific to my setup, but portable):

1. A tmux-side helper (`scripts/tmux-session-switcher.sh`) lists your tmux
   sessions, lets you pick one with fzf, and writes its name to a file:
   ```sh
   printf '%s' "$session" > /path/to/last_tmux_session
   ```
    Bind it in `~/.tmux.conf` and it runs whenever you switch sessions:
   ```
   bind s run-shell "bash /path/to/tmux-session-switcher.sh"
   ```
   The file is your "last used session" tracker. (Mine lives on the SSH
   target at `~/.config/web-ssh/last_tmux_session` — change the path in the
   script to whatever you want, it just needs to be reachable by your ssh
   user.)

2. web-ssh knows where that file is via `last_tmux_session_path` in
   `config.json`. On every connection it reads the file and types
   `tmux a -t "$(< path)"` into the fresh shell, so you land straight back
   into your last session — no client-side reattach logic, no storage in the
   web-ssh process, works even after the app was force-quit.

It's a hand-rolled alternative to `tmux attach`'s built-in "most recently
used" session pick, because I found that choice unreliable when juggling
several long-lived sessions. The file-tracking lets me decide explicitly
what "my session" means. Needs `tmux`, `fzf` and `fd` on the target; the script
uses `switch-client`, so it's meant to be run from inside tmux.


# Todos
- [ ] qmk inspired remaping control
- [ ] modifying config from client
