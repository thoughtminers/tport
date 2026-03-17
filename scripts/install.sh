#!/bin/sh
# devpilot installer
# Usage: curl -fsSL https://raw.githubusercontent.com/thoughtminers/devpilot/main/scripts/install.sh | sh

set -e

REPO="thoughtminers/devpilot"
INSTALL_DIR="${DEVPILOT_INSTALL_DIR:-$HOME/.devpilot}"

# ── Detect platform ───────────────────────────────────────────────────────────

OS=$(uname -s | tr '[:upper:]' '[:lower:]')
ARCH=$(uname -m)

case "$OS" in
  darwin) PLATFORM="darwin" ;;
  linux)  PLATFORM="linux"  ;;
  *)
    echo "Unsupported OS: $OS"
    exit 1
    ;;
esac

case "$ARCH" in
  arm64|aarch64) ARCH="arm64" ;;
  x86_64)        ARCH="x64"   ;;
  *)
    echo "Unsupported architecture: $ARCH"
    exit 1
    ;;
esac

# ── Fetch latest release ──────────────────────────────────────────────────────

echo "Fetching latest devpilot release..."
RELEASE_JSON=$(curl -fsSL "https://api.github.com/repos/${REPO}/releases/latest")
VERSION=$(echo "$RELEASE_JSON" | grep '"tag_name"' | head -1 | sed 's/.*"tag_name": *"v\?\([^"]*\)".*/\1/')

if [ -z "$VERSION" ]; then
  echo "Failed to determine latest version."
  exit 1
fi

echo "Latest version: v${VERSION}"

TARBALL="devpilot-${VERSION}-${PLATFORM}-${ARCH}.tar.gz"
SHA256_FILE="${TARBALL}.sha256"

TAR_URL=$(echo "$RELEASE_JSON" | grep "browser_download_url" | grep "$TARBALL\"" | head -1 | sed 's/.*"browser_download_url": *"\([^"]*\)".*/\1/')
SHA256_URL=$(echo "$RELEASE_JSON" | grep "browser_download_url" | grep "${SHA256_FILE}\"" | head -1 | sed 's/.*"browser_download_url": *"\([^"]*\)".*/\1/')

if [ -z "$TAR_URL" ] || [ -z "$SHA256_URL" ]; then
  echo "No release found for ${PLATFORM}-${ARCH}."
  exit 1
fi

# ── Download & verify ─────────────────────────────────────────────────────────

TMP_DIR=$(mktemp -d)
trap 'rm -rf "$TMP_DIR"' EXIT

echo "Downloading $TARBALL..."
curl -fsSL "$TAR_URL" -o "$TMP_DIR/$TARBALL"

echo "Verifying checksum..."
EXPECTED=$(curl -fsSL "$SHA256_URL" | awk '{print $1}')

if command -v sha256sum >/dev/null 2>&1; then
  ACTUAL=$(sha256sum "$TMP_DIR/$TARBALL" | awk '{print $1}')
elif command -v shasum >/dev/null 2>&1; then
  ACTUAL=$(shasum -a 256 "$TMP_DIR/$TARBALL" | awk '{print $1}')
else
  echo "Warning: no sha256 tool found, skipping checksum verification."
  ACTUAL="$EXPECTED"
fi

if [ "$ACTUAL" != "$EXPECTED" ]; then
  echo "Checksum mismatch! Aborting."
  exit 1
fi

# ── Install ───────────────────────────────────────────────────────────────────

echo "Installing to $INSTALL_DIR..."

# Backup existing install if present, preserving config.json
BACKUP=""
if [ -d "$INSTALL_DIR" ]; then
  BACKUP="${INSTALL_DIR}-backup-$(date +%s)"
  mv "$INSTALL_DIR" "$BACKUP"
  echo "Previous install backed up to $BACKUP"
fi

# Extract
tar -xzf "$TMP_DIR/$TARBALL" -C "$TMP_DIR"
EXTRACTED=$(find "$TMP_DIR" -maxdepth 1 -type d -name "devpilot-*" | head -1)

mv "$EXTRACTED" "$INSTALL_DIR"

# Ensure executables are marked
chmod +x "$INSTALL_DIR/bin/devpilot"
chmod +x "$INSTALL_DIR/bin/node"

# chmod spawn-helper on macOS
find "$INSTALL_DIR/lib/node_modules/node-pty" -name "spawn-helper" -exec chmod +x {} \; 2>/dev/null || true

# Restore config.json from backup if it existed, otherwise create default
CONFIG="$INSTALL_DIR/config.json"
if [ -n "$BACKUP" ] && [ -f "$BACKUP/config.json" ]; then
  cp "$BACKUP/config.json" "$CONFIG"
  rm -rf "$BACKUP"
elif [ ! -f "$CONFIG" ]; then
  printf '{\n  "port": 3010\n}\n' > "$CONFIG"
fi

# ── PATH setup ────────────────────────────────────────────────────────────────

BIN_DIR="$INSTALL_DIR/bin"
PATH_LINE="export PATH=\"\$PATH:$BIN_DIR\""

add_to_rc() {
  RC="$1"
  if [ -f "$RC" ] && ! grep -q "$BIN_DIR" "$RC" 2>/dev/null; then
    printf '\n# devpilot\n%s\n' "$PATH_LINE" >> "$RC"
    echo "Added to $RC"
  fi
}

add_to_rc "$HOME/.zshrc"
add_to_rc "$HOME/.bashrc"
add_to_rc "$HOME/.bash_profile"

# ── Done ──────────────────────────────────────────────────────────────────────

echo ""
echo "devpilot v${VERSION} installed!"
echo ""
echo "  Reload your shell or run:"
echo "    export PATH=\"\$PATH:$BIN_DIR\""
echo ""
echo "  Then start a session:"
echo "    devpilot start"
echo ""
