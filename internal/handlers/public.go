package handlers

import "net/http"

func Assets() http.Handler {
	return http.StripPrefix("/public/", http.FileServer(http.Dir("./public")))
}
