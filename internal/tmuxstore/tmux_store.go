package tmuxstore

import (
	"strings"
	"sync"

	"golang.org/x/crypto/ssh"
)

type TmuxStore struct {
	mu sync.Mutex
	m  map[string]string
}

func New() *TmuxStore {
	return &TmuxStore{m: map[string]string{}}
}

func (s *TmuxStore) Get(key string) string {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.m[key]
}

func (s *TmuxStore) Set(key, val string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.m[key] = val
}

func (s *TmuxStore) ReadFrom(conn *ssh.Client) string {
	sess, err := conn.NewSession()
	if err != nil {
		return ""
	}
	defer sess.Close()
	out, err := sess.Output("tmux set -g destroy-unattached off; tmux ls -F '#{session_name} #{session_attached}'")
	if err != nil {
		return ""
	}
	for _, line := range strings.Split(strings.TrimSpace(string(out)), "\n") {
		f := strings.Fields(line)
		if len(f) == 2 && f[1] == "1" {
			return f[0]
		}
	}
	return ""
}
