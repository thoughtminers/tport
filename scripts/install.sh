#!/bin/sh
# tport installer
# Usage: curl -fsSL https://raw.githubusercontent.com/thoughtminers/tport/main/scripts/install.sh | sh

set -e

REPO="thoughtminers/tport"
INSTALL_DIR="${TPORT_INSTALL_DIR:-$HOME/.tport}"

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

# ── Disclaimer ────────────────────────────────────────────────────────────────

echo ""
echo "WARNING: tport exposes a live terminal session over your local network."
echo "Anyone with access to the dashboard can execute commands on your machine."
echo "The authors are not responsible for any damage or unauthorized access"
echo "resulting from the use of this tool."
echo ""
printf "Do you accept full responsibility and wish to continue? [y/N] "
read -r ACCEPT
case "$ACCEPT" in
  y|Y|yes|YES) ;;
  *)
    echo "Installation cancelled."
    exit 0
    ;;
esac
echo ""

# ── Fetch latest release ──────────────────────────────────────────────────────

echo "Fetching latest tport release..."
RELEASE_JSON=$(curl -fsSL "https://api.github.com/repos/${REPO}/releases/latest")
VERSION=$(echo "$RELEASE_JSON" | grep '"tag_name"' | head -1 | sed 's/.*"tag_name": *"v\([^"]*\)".*/\1/')

if [ -z "$VERSION" ]; then
  echo "Failed to determine latest version."
  exit 1
fi

echo "Latest version: v${VERSION}"

TARBALL="tport-${VERSION}-${PLATFORM}-${ARCH}.tar.gz"
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
EXTRACTED=$(find "$TMP_DIR" -maxdepth 1 -type d -name "tport-*" | head -1)

mv "$EXTRACTED" "$INSTALL_DIR"

# Ensure executables are marked
chmod +x "$INSTALL_DIR/bin/tport"
chmod +x "$INSTALL_DIR/bin/node"

# chmod spawn-helper on macOS
find "$INSTALL_DIR/lib/node_modules/node-pty" -name "spawn-helper" -exec chmod +x {} \; 2>/dev/null || true

# Restore config.json from backup if it existed, otherwise create default
CONFIG="$INSTALL_DIR/config.json"
if [ -n "$BACKUP" ] && [ -f "$BACKUP/config.json" ]; then
  cp "$BACKUP/config.json" "$CONFIG"
  rm -rf "$BACKUP"
elif [ ! -f "$CONFIG" ]; then
  printf "Set a dashboard password (leave empty for no auth): "
  read -r PASS
  if [ -n "$PASS" ]; then
    if command -v sha256sum >/dev/null 2>&1; then
      HASH=$(printf '%s' "$PASS" | sha256sum | awk '{print $1}')
    elif command -v shasum >/dev/null 2>&1; then
      HASH=$(printf '%s' "$PASS" | shasum -a 256 | awk '{print $1}')
    else
      echo "Warning: no sha256 tool found, skipping password setup."
      HASH=""
    fi
    if [ -n "$HASH" ]; then
      printf '{\n  "port": 3010,\n  "passwordHash": "%s"\n}\n' "$HASH" > "$CONFIG"
    else
      printf '{\n  "port": 3010\n}\n' > "$CONFIG"
    fi
  else
    printf '{\n  "port": 3010\n}\n' > "$CONFIG"
  fi
fi

# ── PATH setup ────────────────────────────────────────────────────────────────

BIN_DIR="$INSTALL_DIR/bin"
PATH_LINE="export PATH=\"\$PATH:$BIN_DIR\""

add_to_rc() {
  RC="$1"
  if [ -f "$RC" ] && ! grep -q "$BIN_DIR" "$RC" 2>/dev/null; then
    printf '\n# tport\n%s\n' "$PATH_LINE" >> "$RC"
    echo "Added to $RC"
  fi
}

add_to_rc "$HOME/.zshrc"
add_to_rc "$HOME/.bashrc"
add_to_rc "$HOME/.bash_profile"

# ── Done ──────────────────────────────────────────────────────────────────────

echo ""
echo "tport v${VERSION} installed!"
echo ""
echo "  Reload your shell or run:"
echo "    export PATH=\"\$PATH:$BIN_DIR\""
echo ""
echo "  Then start a session:"
echo "    tport start"
echo ""
