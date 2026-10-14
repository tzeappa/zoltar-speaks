#!/bin/bash
# One-line install for Mac:
#   curl -fsSL https://raw.githubusercontent.com/tzeappa/zoltar-speaks/main/install.sh | bash
# Downloads Zoltar into ~/Zoltar (updating it if it is already there, keeping settings and data) and starts it.
# ZOLTAR_DIR installs somewhere else.
set -euo pipefail

# Everything is in main so a download cut off midway by `curl | bash` runs nothing at all.
main() {
  REPO="tzeappa/zoltar-speaks"
  BRANCH="main"
  DEST="${ZOLTAR_DIR:-$HOME/Zoltar}"
  ZIP_URL="${ZOLTAR_ZIP_URL:-https://codeload.github.com/$REPO/zip/refs/heads/$BRANCH}"

  printf '\n\033[1mInstalling Zoltar Speaks into %s\033[0m\n' "$DEST"
  [ "$(uname)" = Darwin ] || { printf '  This installer is for Mac.\n'; exit 1; }

  tmp=$(mktemp -d)
  trap 'rm -rf "$tmp"' EXIT
  curl -fL --progress-bar -o "$tmp/zoltar.zip" "$ZIP_URL" ||
    { printf '  Could not download Zoltar. Check the internet connection and try again.\n'; exit 1; }
  unzip -q "$tmp/zoltar.zip" -d "$tmp"

  if [ -e "$DEST" ] && [ ! -f "$DEST/scripts/start.sh" ] && [ -n "$(ls -A "$DEST")" ]; then
    printf '  %s already exists and is not a Zoltar folder. Move it, or choose another folder with ZOLTAR_DIR.\n' "$DEST"
    exit 1
  fi
  [ -e "$DEST" ] || created=1
  # An update while Zoltar runs would leave the old version running; the starter below then starts the new one.
  [ -f "$DEST/scripts/stop.sh" ] && bash "$DEST/scripts/stop.sh" --app-only >/dev/null 2>&1
  mkdir -p "$DEST"
  # The download never contains .env, data/, .runtime/, node_modules/, or .zoltar-installed, so copying over keeps them.
  cp -R "$tmp"/*/. "$DEST/"
  # Lets the uninstaller delete the whole folder, which it only does for a folder this script created.
  if [ -n "${created:-}" ]; then echo "folder created by install.sh" >>"$DEST/.zoltar-installed"; fi
  chmod +x "$DEST"/*.command "$DEST"/scripts/*.sh
  printf '  Done. Next time, double-click "Start Zoltar" in that folder.\n'
  # exec below replaces this shell, so the EXIT trap would never run.
  rm -rf "$tmp"
  trap - EXIT

  open "$DEST"
  exec bash "$DEST/scripts/start.sh" </dev/null
}

main "$@"
