package handlers

import "net/http"

func Assets() http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Cache-Control", "no-store")
		w.Header().Set("Expires", "0")
		http.StripPrefix("/public/", http.FileServer(http.Dir("./public"))).ServeHTTP(w, r)
	}
}
