#!/bin/bash

session=$(tmux list-sessions -F '#{session_name}' | fzf --header "Select Session")

if [ -z "$session" ]; then
    exit 0
fi

# make sure the dir exists, the file will be autocreated 
# or you can create it manually
file_path=/path/to/your/file

printf '%s' "$session" > "$file_path"

tmux switch-client -t "$session"
