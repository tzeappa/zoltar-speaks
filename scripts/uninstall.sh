#!/bin/bash
# Removes Zoltar Speaks and everything it added to this computer: the Node.js and Ollama it downloaded, the AI
# models it pulled, its data and logs. Things that were already there before Zoltar (your own Node, Homebrew
# packages, Ollama models) are kept: the installers record what they add in .zoltar-installed, and only that goes.
# Used by "Uninstall Zoltar.command" and `make uninstall`. Pass --yes to skip the confirmation.
set -uo pipefail

cd "$(dirname "$0")/.." || exit 1
ROOT=$PWD
MANIFEST="$ROOT/.zoltar-installed"

bold() { printf '\n\033[1m%s\033[0m\n' "$*"; }
say() { printf '  %s\n' "$*"; }
recorded() { [ -f "$MANIFEST" ] && grep -qxF "$1" "$MANIFEST"; }
recorded_list() { [ -f "$MANIFEST" ] && sed -n "s/^$1 //p" "$MANIFEST"; }

ollama_url() {
  local url
  url=$(sed -n 's/^OLLAMA_URL=//p' .env 2>/dev/null | tail -n 1)
  echo "${url:-http://127.0.0.1:11434}"
}

find_ollama() {
  local c
  for c in "$ROOT/.runtime/ollama/ollama" "$(command -v ollama 2>/dev/null)" /opt/homebrew/bin/ollama /usr/local/bin/ollama \
    /Applications/Ollama.app/Contents/Resources/ollama; do
    [ -n "$c" ] && [ -x "$c" ] && { echo "$c"; return; }
  done
}

find_brew() {
  local c
  for c in "$(command -v brew 2>/dev/null)" /opt/homebrew/bin/brew /usr/local/bin/brew; do
    [ -n "$c" ] && [ -x "$c" ] && { echo "$c"; return; }
  done
}

main() {
  local yes="" models formulas whole_folder="" ours_ollama="" url temp_pid="" m
  [ "${1:-}" = --yes ] && yes=1

  models=$(recorded_list model)
  formulas=$(recorded_list brew)
  url=$(ollama_url)
  if recorded "folder created by install.sh" && [ -f "$ROOT/scripts/start.sh" ] && [ "$ROOT" != "$HOME" ] && [ "$ROOT" != / ]; then
    whole_folder=1
  fi
  if [ -d "$ROOT/.runtime/ollama" ] || grep -qx ollama <<<"$formulas"; then ours_ollama=1; fi

  bold "Uninstall Zoltar Speaks"
  say "This removes:"
  if [ -n "$whole_folder" ]; then
    say "  - the Zoltar folder $ROOT, with its settings, data and logs"
  else
    say "  - Zoltar's settings, data, logs and packages in $ROOT (the source code stays)"
  fi
  [ -d "$ROOT/.runtime/node" ] && say "  - the Node.js that Zoltar downloaded"
  [ -d "$ROOT/.runtime/ollama" ] && say "  - the Ollama that Zoltar downloaded"
  for m in $formulas; do say "  - Homebrew package $m (Zoltar installed it)"; done
  for m in $models; do say "  - AI model $m"; done
  recorded "created ~/.ollama" && say "  - the ~/.ollama folder, unless it holds models that Zoltar did not download"
  recorded "created ~/.npm" && say "  - the ~/.npm download cache"
  say "Anything that was on this Mac before Zoltar stays."

  if [ -z "$yes" ]; then
    printf '\n  Type yes to uninstall: '
    read -r answer </dev/tty || answer=""
    case "$answer" in y | Y | yes | YES | Yes) ;; *) say "Nothing was changed."; printf '\n'; exit 0 ;; esac
  fi

  bold "Stopping Zoltar"
  # Waits until the app has exited, so its database is closed before the files are deleted.
  bash "$ROOT/scripts/stop.sh" --app-only >/dev/null

  if [ -n "$models" ] || recorded "created ~/.ollama"; then
    bold "Removing AI models"
    if ! curl -fs -m 2 "$url/api/tags" >/dev/null 2>&1; then
      local bin
      bin=$(find_ollama)
      if [ -n "$bin" ]; then
        "$bin" serve >/dev/null 2>&1 &
        temp_pid=$!
        for _ in $(seq 1 20); do curl -fs -m 1 "$url/api/tags" >/dev/null 2>&1 && break; sleep 0.5; done
      fi
    fi
    local reachable=""
    curl -fs -m 2 "$url/api/tags" >/dev/null 2>&1 && reachable=1
    for m in $models; do
      if [ -n "$reachable" ] && curl -fs -m 60 -X DELETE "$url/api/delete" -d "{\"model\":\"$m\",\"name\":\"$m\"}" >/dev/null 2>&1; then
        say "Removed $m"
      elif [ -z "$reachable" ] && recorded "created ~/.ollama" && [ -z "$(other_models "$models")" ]; then
        : # removed with ~/.ollama below
      else
        say "Could not remove $m (already gone, or Ollama is not reachable)"
      fi
    done
    if recorded "created ~/.ollama" && [ -d "$HOME/.ollama" ]; then
      local tags others
      if [ -n "$reachable" ]; then
        tags=$(curl -fs -m 5 "$url/api/tags" || true)
        grep -q '"name"' <<<"$tags" && others=1
      else
        # Ollama is not reachable, so read the model list from disk instead.
        [ -n "$(other_models "$models")" ] && others=1
      fi
      if [ -n "${others:-}" ]; then
        say "Kept ~/.ollama: it holds other AI models that Zoltar did not download."
      else
        stop_ollama "$temp_pid" "$ours_ollama"
        rm -rf "$HOME/.ollama" && say "Removed ~/.ollama"
      fi
    fi
  fi
  stop_ollama "$temp_pid" "$ours_ollama"

  if [ -d "$ROOT/.runtime" ]; then
    bold "Removing the downloaded Node.js and Ollama"
    rm -rf "$ROOT/.runtime" && say "Done"
  fi

  if [ -n "$formulas" ]; then
    bold "Removing Homebrew packages Zoltar installed"
    local brew left pass
    brew=$(find_brew)
    if [ -z "$brew" ]; then
      say "Homebrew is not available, so these were left: $(echo "$formulas" | tr '\n' ' ')"
    else
      # Several passes, because a package can only go once nothing depends on it. Packages that something
      # else on this Mac still needs are kept.
      left=$formulas
      for pass in 1 2 3; do
        local next=""
        for m in $left; do
          if ! "$brew" list --formula "$m" >/dev/null 2>&1; then continue; fi
          if "$brew" uninstall --formula "$m" >/dev/null 2>&1; then say "Removed $m"; else next="$next $m"; fi
        done
        left=$next
        [ -z "$left" ] && break
        [ "$pass" = 3 ] && say "Kept (other software still needs them):$left"
      done
      # shellcheck disable=SC2086 # one argument per formula
      "$brew" cleanup --prune=all $formulas >/dev/null 2>&1
    fi
  fi

  if recorded linux-ollama; then
    bold "Ollama"
    say "Ollama was installed system-wide with its Linux installer. To remove it, follow"
    say "https://github.com/ollama/ollama/blob/main/docs/linux.md#uninstall"
  fi

  if recorded "created ~/.npm" && [ -d "$HOME/.npm" ]; then
    rm -rf "$HOME/.npm"
  fi
  rm -rf "${TMPDIR:-/tmp}/tsx-$(id -u)"

  bold "Removing Zoltar's files"
  if [ -n "$whole_folder" ]; then
    cd "$HOME" || exit 1
    rm -rf "$ROOT" && say "Removed $ROOT"
  else
    rm -rf node_modules data eval/results .env "$MANIFEST"
    say "Removed settings, data, logs and packages. The source code in $ROOT stays; delete the folder if you no longer need it."
  fi

  bold "Zoltar is uninstalled."
  printf '\n'
}

# Models on disk, as name:tag, other than the ones listed in $1. Used when Ollama cannot be asked.
other_models() {
  local dir="$HOME/.ollama/models/manifests" f rel name
  [ -d "$dir" ] || return 0
  find "$dir" -type f | while read -r f; do
    rel=${f#"$dir"/}
    case "$rel" in
      registry.ollama.ai/library/*) rel=${rel#registry.ollama.ai/library/} ;;
    esac
    name="${rel%/*}:${rel##*/}"
    grep -qxF "$name" <<<"$1" || echo "$name"
  done
}

# Stops the Ollama server when it is Zoltar's: the one Zoltar started (data/ollama.pid), the one started just for
# the uninstall, and any running from a copy of Ollama that Zoltar installed and is about to remove. An Ollama that
# was on this Mac before Zoltar keeps running.
stop_ollama() {
  local temp_pid=$1 ours=$2 pid exe
  if [ -n "$temp_pid" ]; then
    kill "$temp_pid" 2>/dev/null
    wait "$temp_pid" 2>/dev/null
  fi
  if [ -f "$ROOT/data/ollama.pid" ]; then
    pid=$(cat "$ROOT/data/ollama.pid")
    ps -o command= -p "$pid" 2>/dev/null | grep -q "ollama serve" && kill "$pid" 2>/dev/null
  fi
  if [ -n "$ours" ]; then
    for pid in $(pgrep -f "ollama serve"); do
      exe=$(lsof -a -p "$pid" -d txt -Fn 2>/dev/null | sed -n 's/^n//p' | head -n 1)
      case "$exe" in
        "$ROOT/.runtime/"* | /opt/homebrew/Cellar/ollama/* | /usr/local/Cellar/ollama/*) kill "$pid" 2>/dev/null ;;
      esac
    done
  fi
  sleep 1
  return 0
}

# Everything runs from main so bash has read the whole script before it can delete the folder holding it.
main "$@"
exit 0
