package handlers

import (
	"errors"
	"io"
	"io/fs"
	"log/slog"
	"net/http"
	"os"
	"sync"
	"time"

	"github.com/antoni-ostrowski/web-shell/internal/config"
	"github.com/antoni-ostrowski/web-shell/internal/tmuxstore"
	"github.com/gorilla/websocket"
	"golang.org/x/crypto/ssh"
	"golang.org/x/crypto/ssh/knownhosts"
)

const (
	readSize = 32 * 1024
	// batchSize is the max bytes buffered before an immediate flush.
	batchSize = 16 * 1024
	// flushDelay is the output coalesce window. First byte of a burst
	// waits at most this long; everything arriving during the window
	// rides in the same frame. Keep tiny — this is on the latency path.
	flushDelay = time.Millisecond

	opData   = 'd' // payload: raw bytes for ssh stdin
	opResize = 'r' // payload: cols uint16 LE, rows uint16 LE
)

type SSH struct {
	tmuxStore *tmuxstore.TmuxStore
}

func NewSSH(t *tmuxstore.TmuxStore) *SSH {
	return &SSH{t}
}

var upgrader = websocket.Upgrader{
	CheckOrigin: func(r *http.Request) bool { return true },
}

func (s *SSH) Register(mux *http.ServeMux) {
	mux.HandleFunc("/ssh/{name}", s.page)
	mux.HandleFunc("/connect/{name}", s.conn)

}

func (s *SSH) page(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Cache-Control", "no-store")
	http.ServeFile(w, r, "./public/ssh.html")
}

func (s *SSH) conn(w http.ResponseWriter, r *http.Request) {
	server, err := config.GetServer(r.PathValue("name"))
	if err != nil {
		msg := "failed to get server details"
		slog.Error(msg, "error", err)
		http.Error(w, msg, http.StatusBadRequest)
		return
	}
	wsConn, err := upgrader.Upgrade(w, r, nil)
	if err != nil {
		slog.Error("failed to upgrade websocket", "error", err)
		return
	}
	defer wsConn.Close()

	// Keepalive: Cloudflare drops idle WebSockets (~100s silence).
	// Pings are sent by pumpOutputs (the single writer goroutine).
	// Pong handler extends the read deadline so truly-dead clients
	// get reaped instead of lingering forever.
	const pongTimeout = 90 * time.Second
	wsConn.SetReadDeadline(time.Now().Add(pongTimeout))
	wsConn.SetPongHandler(func(string) error {
		return wsConn.SetReadDeadline(time.Now().Add(pongTimeout))
	})

	knownHosts, err := knownhosts.New(knownHostsPath())
	if err != nil {
		slog.Error("failed to get ssh known hosts", "error", err)
		if errors.Is(err, fs.ErrNotExist) {
			err = os.WriteFile(knownHostsPath(), []byte(nil), 0o644)
		} else {
			return
		}
	}
	sshConfig := &ssh.ClientConfig{
		User: server.User,
		Auth: []ssh.AuthMethod{
			ssh.Password(server.Password),
		},
		HostKeyCallback:   knownHosts,
		HostKeyAlgorithms: []string{"ssh-ed25519"},
		Timeout:           10 * time.Second,
	}

	conn, err := ssh.Dial("tcp", server.Host+":22", sshConfig)
	if err != nil {
		slog.Error("failed to dial conn", "error", err)
		return
	}
	defer conn.Close()

	session, err := conn.NewSession()
	if err != nil {
		slog.Error("failed to open new session via ssh", "error", err)
		return
	}
	defer session.Close()

	modes := ssh.TerminalModes{
		ssh.ECHO: 1,
		// High baud makes ncurses/vim pick aggressive redraw strategies
		// (fewer cursor moves, bigger writes) — noticeably snappier in nvim.
		ssh.TTY_OP_ISPEED: 4000000,
		ssh.TTY_OP_OSPEED: 4000000,
	}

	if err := session.RequestPty("xterm-256color", 24, 80, modes); err != nil {
		slog.Error("failed to request pty", "error", err)
		return
	}

	stdin, err := session.StdinPipe()
	if err != nil {
		return
	}

	stdout, err := session.StdoutPipe()
	if err != nil {
		slog.Error("failed to open stdout pipe", "error", err)
		return
	}

	stderr, err := session.StderrPipe()
	if err != nil {
		slog.Error("failed to open stderr pipe", "error", err)
		return
	}

	if err := session.Shell(); err != nil {
		slog.Error("failed to open shell", "error", err)
		return
	}

	go pumpOutputs(wsConn, stdout, stderr)

	// receiving and piping to ssh pipe
	go func() {
		wsConn.SetReadLimit(1 << 20)
		for {
			_, raw, err := wsConn.ReadMessage()
			if err != nil {
				slog.Error("reading ws message:", err.Error(), nil)
				break
			} else if len(raw) == 0 {
				continue
			}

			switch raw[0] {
			case opData:
				if _, err := stdin.Write(raw[1:]); err != nil {
					slog.Error("failed to write ssh session", "error", err)
				}
			case opResize:
				if len(raw) >= 5 {
					cols := uint16(raw[1]) | uint16(raw[2])<<8
					rows := uint16(raw[3]) | uint16(raw[4])<<8
					if cols > 0 && rows > 0 {
						if err := session.WindowChange(int(rows), int(cols)); err != nil {
							slog.Error("failed to resize pty", "error", err)
						}
					}
				}
			}
		}
		if sess := s.tmuxStore.ReadFrom(conn); sess != "" {
			slog.Info("saving tmux session", "session_name", sess, "for_server", server.Name)
			s.tmuxStore.Set(server.Name, sess)
		}
		session.Close()
		conn.Close()
	}()

	if name := s.tmuxStore.Get(server.Name); name != "" {
		slog.Info("successfuly read tmux session name from store (reattaching) ", "session_name", name, "for_server", server.Name)
		stdin.Write([]byte("tmux a -t " + name + "\r"))
	}

	if err := session.Wait(); err != nil {
		slog.Info("ssh session ended", "error", err)
	}
}

// pumpOutputs reads from all sources and writes to the websocket.
// A single flusher goroutine owns wsConn writes (gorilla allows one
// concurrent writer). Output is coalesced: the first chunk of a burst
// waits at most flushDelay, later chunks ride in the same frame until
// batchSize forces an immediate flush.
func pumpOutputs(wsConn *websocket.Conn, sources ...io.Reader) {
	chunks := make(chan []byte, 64)

	var wg sync.WaitGroup
	for _, src := range sources {
		wg.Add(1)
		go func(r io.Reader) {
			defer wg.Done()
			buf := make([]byte, readSize)
			for {
				n, err := r.Read(buf)
				if n > 0 {
					chunk := make([]byte, n)
					copy(chunk, buf[:n])
					chunks <- chunk
				}
				if err != nil {
					return
				}
			}
		}(src)
	}
	go func() {
		wg.Wait()
		close(chunks)
	}()

	var batch []byte
	timer := time.NewTimer(time.Hour)
	timer.Stop()

	// Keepalive: Cloudflare drops WebSockets after ~100s of silence.
	// Ping from this goroutine only — it's the sole wsConn writer, and
	// gorilla forbids concurrent writes. Browsers auto-pong.
	pingTicker := time.NewTicker(30 * time.Second)
	defer pingTicker.Stop()

	flush := func() error {
		if len(batch) == 0 {
			return nil
		}
		err := wsConn.WriteMessage(websocket.BinaryMessage, batch)
		batch = batch[:0]
		return err
	}
	stopTimer := func() {
		if !timer.Stop() {
			select {
			case <-timer.C:
			default:
			}
		}
	}

	for {
		select {
		case chunk, ok := <-chunks:
			if !ok {
				_ = flush()
				return
			}
			if len(batch) == 0 {
				timer.Reset(flushDelay)
			}
			batch = append(batch, chunk...)
			if len(batch) >= batchSize {
				stopTimer()
				if err := flush(); err != nil {
					return
				}
			}
		case <-timer.C:
			if err := flush(); err != nil {
				return
			}
		case <-pingTicker.C:
			if err := wsConn.WriteMessage(websocket.PingMessage, nil); err != nil {
				return
			}
		}
	}
}

func knownHostsPath() string {
	if p := os.Getenv("SSH_KNOWN_HOSTS"); p != "" {
		return p
	}
	return "/app/config/known_hosts"
}
