#!/bin/bash
# Starts Zoltar Speaks on a Mac with nothing preinstalled: downloads Node and Ollama into .runtime/ if they are
# missing (no Homebrew, no admin password), starts Ollama and the app, and opens the browser.
# Used by "Start Zoltar.command" and install.sh. Developers can keep using `make dev`.
set -euo pipefail

cd "$(dirname "$0")/.."
ROOT=$PWD
RUNTIME="$ROOT/.runtime"
NODE_MAJOR=24
mkdir -p "$ROOT/data" "$RUNTIME"
LOG="$ROOT/data/zoltar.log"
PIDFILE="$ROOT/data/zoltar.pid"
LAUNCHER_PIDFILE="$ROOT/data/zoltar-launcher.pid"

# What Zoltar added to the machine, read by scripts/uninstall.sh. Only things that were not there before.
record() { grep -qxF "$1" .zoltar-installed 2>/dev/null || echo "$1" >>.zoltar-installed; }

bold() { printf '\n\033[1m%s\033[0m\n' "$*"; }
say() { printf '  %s\n' "$*"; }
fail() {
  printf '\n  \033[31mZoltar could not start.\033[0m %s\n' "$1"
  [ -n "${2:-}" ] && printf '  %s\n' "$2"
  printf '\n  If you ask someone for help, send them the file data/zoltar.log in the Zoltar folder.\n\n'
  exit 1
}

bold "Zoltar Speaks"

[ "$(uname)" = Darwin ] || fail "This starter is for Mac." "On Linux, use: make setup && make dev"
command -v curl >/dev/null || fail "curl is missing, which every Mac includes. Is this a standard macOS install?"

case "$(uname -m)" in
  arm64) ARCH=arm64 ;;
  x86_64) ARCH=x64 ;;
  *) fail "Unsupported processor: $(uname -m)." ;;
esac

# ---------- Node ----------

node_ok() { [ -x "$1" ] && [ "$("$1" -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0)" -ge "$NODE_MAJOR" ]; }

if node_ok "$RUNTIME/node/bin/node"; then
  export PATH="$RUNTIME/node/bin:$PATH"
elif command -v node >/dev/null && node_ok "$(command -v node)"; then
  : # a recent enough Node is already installed
else
  bold "Getting Node.js (one time, about 50 MB)"
  base="https://nodejs.org/dist/latest-v$NODE_MAJOR.x"
  line=$(curl -fsSL "$base/SHASUMS256.txt" | grep " node-v.*-darwin-$ARCH.tar.gz\$") || fail "Could not reach nodejs.org." "Check the internet connection and try again."
  sum=${line%% *}
  file=${line##* }
  curl -fL --progress-bar -o "$RUNTIME/node.tar.gz" "$base/$file" || fail "Downloading Node.js failed." "Check the internet connection and try again."
  echo "$sum  $RUNTIME/node.tar.gz" | shasum -a 256 -c --status || fail "The Node.js download was damaged." "Try again."
  rm -rf "$RUNTIME/node" && mkdir -p "$RUNTIME/node"
  tar xzf "$RUNTIME/node.tar.gz" -C "$RUNTIME/node" --strip-components 1
  rm "$RUNTIME/node.tar.gz"
  export PATH="$RUNTIME/node/bin:$PATH"
  say "Node.js $(node -v) ready"
fi

# ---------- App packages ----------

if [ ! -f node_modules/.package-lock.json ] || [ package-lock.json -nt node_modules/.package-lock.json ]; then
  bold "Installing the app (one time, about a minute)"
  [ -d "$HOME/.npm" ] || record "created ~/.npm"
  npm ci --no-audit --no-fund --loglevel=error >>"$LOG" 2>&1 || fail "Installing the app failed." "Check the internet connection and try again."
  say "Done"
fi

# ---------- Settings ----------

if [ ! -f .env ]; then
  cp .env.example .env
  ram_gb=$(($(sysctl -n hw.memsize) / 1073741824))
  if [ "$ram_gb" -lt 16 ]; then
    # qwen3:8b needs about 8 GB while running; on smaller Macs a 4B model leaves room for everything else.
    sed -i '' -e 's/^OLLAMA_MODEL_FAST=.*/OLLAMA_MODEL_FAST=qwen3:4b/' -e 's/^OLLAMA_MODEL_SMART=.*/OLLAMA_MODEL_SMART=qwen3:4b/' .env
    say "This Mac has ${ram_gb} GB of memory, so Zoltar will use a smaller AI model."
  fi
fi

# Captured first: `eval "$(cmd)" || fail` would never fail, because eval of empty output succeeds.
settings=$(node --import tsx scripts/settings.ts 2>>"$LOG") || fail "The settings file (.env) has an error." "Open .env in TextEdit and undo the last change, or delete it to go back to the defaults."
eval "$settings"
URL="http://localhost:$PORT"

# ---------- Already running? ----------

health=$(curl -fs -m 2 "$URL/healthz" 2>/dev/null || true)
if grep -q '"db"' <<<"$health"; then
  say "Zoltar is already running. Opening it in your browser."
  open "$URL"
  exit 0
fi
if lsof -nP -iTCP:"$PORT" -sTCP:LISTEN >/dev/null 2>&1; then
  fail "Another program is using port $PORT." "Close it, or set a different PORT in the .env file."
fi

# ---------- Ollama ----------

if [ "$MODE" = ollama ]; then
  if [ -x "$RUNTIME/ollama/ollama" ]; then
    export PATH="$RUNTIME/ollama:$PATH"
  elif command -v ollama >/dev/null; then
    :
  elif [ -x /Applications/Ollama.app/Contents/Resources/ollama ]; then
    export PATH="/Applications/Ollama.app/Contents/Resources:$PATH"
  else
    bold "Getting Ollama, the local AI engine (one time, about 170 MB)"
    rel="https://github.com/ollama/ollama/releases/latest/download"
    sum=$(curl -fsSL "$rel/sha256sum.txt" | awk '$2 == "./ollama-darwin.tgz" {print $1}') || fail "Could not reach GitHub to download Ollama." "Check the internet connection and try again."
    curl -fL --progress-bar -o "$RUNTIME/ollama.tgz" "$rel/ollama-darwin.tgz" || fail "Downloading Ollama failed." "Check the internet connection and try again."
    echo "$sum  $RUNTIME/ollama.tgz" | shasum -a 256 -c --status || fail "The Ollama download was damaged." "Try again."
    rm -rf "$RUNTIME/ollama" && mkdir -p "$RUNTIME/ollama"
    tar xzf "$RUNTIME/ollama.tgz" -C "$RUNTIME/ollama"
    rm "$RUNTIME/ollama.tgz"
    export PATH="$RUNTIME/ollama:$PATH"
    say "Ollama ready"
  fi

  free_gb=$(($(df -k "$HOME" | awk 'NR == 2 {print $4}') / 1048576))
  name=${MODEL%%:*}
  tag=${MODEL#*:}
  [ "$tag" = "$MODEL" ] && tag=latest
  if [ ! -f "$HOME/.ollama/models/manifests/registry.ollama.ai/library/$name/$tag" ] && [ "$free_gb" -lt 8 ]; then
    fail "Not enough disk space: the AI model needs about 6 GB and only ${free_gb} GB is free." "Free up some space and try again."
  fi

  bold "Starting the AI engine (the first time downloads the model, about 5 GB)"
  node --import tsx scripts/services.ts || fail "The AI engine did not start." "Details are in data/ollama.log."
fi

# ---------- App ----------

bold "Starting Zoltar"
NODE_ENV=production node --import tsx server/main.ts >>"$LOG" 2>&1 &
APP=$!
echo "$APP" >"$PIDFILE"
# Stop Zoltar signals this script rather than the app, so this window reports a normal stop.
echo $$ >"$LAUNCHER_PIDFILE"

# shellcheck disable=SC2317,SC2329 # called by the trap below (older shellcheck reports SC2317, newer SC2329)
stop() {
  trap - INT TERM HUP
  kill "$APP" 2>/dev/null || true
  wait "$APP" 2>/dev/null || true
  rm -f "$PIDFILE" "$LAUNCHER_PIDFILE"
  printf '\n  Zoltar stopped.\n\n'
  exit 0
}
trap stop INT TERM HUP

for _ in $(seq 1 60); do
  curl -fs -m 1 "$URL/healthz" >/dev/null 2>&1 && break
  kill -0 "$APP" 2>/dev/null || { rm -f "$PIDFILE" "$LAUNCHER_PIDFILE"; tail -n 20 "$LOG"; fail "The app stopped while starting."; }
  sleep 0.5
done
if ! curl -fs -m 1 "$URL/healthz" >/dev/null 2>&1; then
  kill "$APP" 2>/dev/null || true
  rm -f "$PIDFILE" "$LAUNCHER_PIDFILE"
  fail "The app did not answer within 30 seconds."
fi

open "$URL"
bold "Zoltar is running at $URL"
say "It opened in your browser. On the first start the demo requests fill in over about 12 minutes."
say "Keep this window open while you use Zoltar."
say "To stop: close this window, press Control-C, or double-click \"Stop Zoltar\"."

wait "$APP" || true
rm -f "$PIDFILE" "$LAUNCHER_PIDFILE"
trap - INT TERM HUP
tail -n 20 "$LOG"
fail "Zoltar stopped unexpectedly."
