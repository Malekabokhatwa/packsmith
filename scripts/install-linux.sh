#!/usr/bin/env bash
# Install (or update) packsmith for the current user from its AppImage: no root needed.
#   scripts/install-linux.sh [path/to/packsmith-*.AppImage]
# Puts the AppImage in ~/.local/share/packsmith, adds a launcher entry and the icon, and a
# `packsmith` command in ~/.local/bin. Run it again with a newer AppImage to update; run it with
# --uninstall to remove all three (your packs and settings in ~/.config/packsmith stay).
set -euo pipefail

here="$(cd "$(dirname "$0")/.." && pwd)"
dest="$HOME/.local/share/packsmith"
apps="$HOME/.local/share/applications"
icons="$HOME/.local/share/icons/hicolor/512x512/apps"
bin="$HOME/.local/bin"

if [[ ${1:-} == --uninstall ]]; then
  rm -f "${apps:?}/packsmith.desktop" "${icons:?}/packsmith.png" "${bin:?}/packsmith"
  rm -rf "${dest:?}"
  command -v update-desktop-database >/dev/null && update-desktop-database "$apps" >/dev/null 2>&1 || true
  echo "packsmith removed. Your packs and settings are still in ~/.config/packsmith."
  exit 0
fi

src="${1:-$(ls -t "$here"/dist/packsmith-*.AppImage 2>/dev/null | head -1 || true)}"
[[ -n $src && -f $src ]] || { echo "No AppImage found. Build one with 'npm run dist', or pass its path." >&2; exit 1; }

mkdir -p "$dest" "$apps" "$icons" "$bin"
install -m 755 "$src" "$dest/packsmith.AppImage"
if [[ -f $here/build/icon.png ]]; then install -m 644 "$here/build/icon.png" "$icons/packsmith.png"; fi
ln -sf "$dest/packsmith.AppImage" "$bin/packsmith"

cat >"$apps/packsmith.desktop" <<EOF
[Desktop Entry]
Type=Application
Name=packsmith
GenericName=Minecraft modpack builder
Comment=Build, test and fix Minecraft modpacks by describing them
Exec="$dest/packsmith.AppImage" %U
Icon=packsmith
Terminal=false
Categories=Game;
Keywords=minecraft;modpack;mods;modrinth;prism;
StartupWMClass=packsmith
EOF
command -v update-desktop-database >/dev/null && update-desktop-database "$apps" >/dev/null 2>&1 || true
echo "packsmith installed: find it in your app launcher, or run 'packsmith'."
