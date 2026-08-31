package main

import (
	"log"
	"log/slog"
	"net/http"
	"os"
	"time"

	"github.com/antoni-ostrowski/web-shell/internal/config"
	"github.com/antoni-ostrowski/web-shell/internal/handlers"
)

func main() {
	c, err := config.Get()
	if err != nil {
		slog.Error("config: failed to load", "error", err)
		os.Exit(1)
	}
	log.Print("nrsteaitnrseiatrsneirnsei")
	c.Print()

	sshHandttler := handlers.NewSSH(&c)

	mux := http.NewServeMux()

	mux.HandleFunc("/", handlers.IndexPage(c.Servers))
	mux.Handle("/public/", handlers.Assets())
	sshHandler.Register(mux)

	srv := &http.Server{
		Handler:           mux,
		Addr:              ":3000",
		ReadHeaderTimeout: 10 * time.Second,
	}

	slog.Info("listening on :3000")
	if err := srv.ListenAndServe(); err != nil {
		slog.Error("http: failed to start server", "error", err)
		os.Exit(1)
	}
}
