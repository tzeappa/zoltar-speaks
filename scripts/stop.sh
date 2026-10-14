#!/bin/bash
# Stops Zoltar and the Ollama engine it started. Used by "Stop Zoltar.command", the installer, the uninstaller, and
# `make stop` (--app-only), and `make stop-ollama` (--ollama-only).
cd "$(dirname "$0")/.." || exit 1
ROOT=$(pwd -P)

# A pid file outlives a crash or a reboot, and by then its pid may belong to another program, so check what it runs.
pid_of() {
  local p
  [ -f "$1" ] || return 1
  p=$(cat "$1" 2>/dev/null)
  kill -0 "$p" 2>/dev/null && ps -o command= -p "$p" | grep -qE "$2" && echo "$p"
}
cwd_of() {
  if [ -d "/proc/$1" ]; then readlink "/proc/$1/cwd"; else lsof -a -p "$1" -d cwd -Fn 2>/dev/null | sed -n 's/^n//p'; fi
}

printf '\n'
if [ "${1:-}" != --ollama-only ]; then
  # The Mac starter goes first: its own cleanup stops the app, and it would otherwise report an unexpected stop.
  launcher=$(pid_of data/zoltar-launcher.pid 'scripts/start\.sh')
  [ -n "$launcher" ] && kill -TERM "$launcher" 2>/dev/null && sleep 0.5
  # Any other app process from this folder: `make start`, `make dev`, or `npm start`.
  pids="$launcher $(pid_of data/zoltar.pid 'server/main\.ts')"
  for p in $(pgrep -f "tsx.*server/main\.ts"); do
    [ "$(cwd_of "$p")" = "$ROOT" ] && pids="$pids $p"
  done

  if [ -n "${pids// /}" ]; then
    for p in $pids; do kill -TERM "$p" 2>/dev/null; done
    # The app finishes in-flight work for up to 3 seconds before it exits.
    for _ in $(seq 1 50); do
      running=""
      for p in $pids; do kill -0 "$p" 2>/dev/null && running="$running $p"; done
      [ -z "$running" ] && break
      sleep 0.2
    done
    for p in $running; do kill -KILL "$p" 2>/dev/null; done
    printf '  Zoltar stopped.\n'
  else
    printf '  Zoltar was not running.\n'
  fi
  rm -f data/zoltar.pid data/zoltar-launcher.pid
fi

[ "${1:-}" = --app-only ] && exit 0

# Frees the memory the AI model uses. Only the Ollama that Zoltar started is stopped; the Ollama desktop app,
# `brew services`, or an `ollama serve` you started yourself keep running.
if ollama=$(pid_of data/ollama.pid 'ollama serve'); then
  kill -TERM "$ollama"
  printf '  AI engine stopped.\n'
fi
rm -f data/ollama.pid
printf '\n'
