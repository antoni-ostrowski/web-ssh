package handlers

import (
	"html/template"
	"log/slog"
	"net/http"

	"github.com/antoni-ostrowski/web-shell/internal/config"
)

var indexTempl = template.Must(template.ParseFiles("./public/index.html"))

func IndexPage(servers []config.Server) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Cache-Control", "no-store")
		if err := indexTempl.Execute(w, servers); err != nil {
			msg := "failed to execute template"
			slog.Error(msg, "error", err)
			http.Error(w, msg, http.StatusInternalServerError)
			return
		}
	}

}
