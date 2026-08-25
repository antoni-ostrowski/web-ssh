# AGENTS.md

Self-hosted Go web SSH proxy: browser terminal (xterm.js + WebSocket) connecting to backend servers over SSH, built for usable mobile/iPadOS ssh. Single `main.go` server serves static frontend from `public/` and proxies WebSocket sessions (`/connect/{name}`); config in `internal/config` loads `config.json` with server creds. Security is delegated to Cloudflare Tunnel/Zero Trust — no auth built in. Frontend uses bun; Docker deploy via provided Dockerfile/docker-compose.
