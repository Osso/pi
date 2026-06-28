#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
INSTALL_DIR="${PI_DEPLOY_INSTALL_DIR:-$HOME/.local/share/pi}"
BIN_DIR="${PI_DEPLOY_BIN_DIR:-$HOME/.local/bin}"
TMP_INSTALL_DIR="${INSTALL_DIR}.tmp"
OLD_INSTALL_DIR="${INSTALL_DIR}.old"
BUILD_DIR="${PI_DEPLOY_BUILD_DIR:-$ROOT_DIR/packages/coding-agent/binaries}"

require_safe_absolute_dir() {
	local name="$1"
	local value="$2"

	if [[ "$value" != /* ]]; then
		echo "$name must be an absolute path: $value" >&2
		exit 1
	fi

	case "$value" in
		/|/home|/home/"$USER"|"$ROOT_DIR")
			echo "$name is too broad to replace: $value" >&2
			exit 1
			;;
	esac
}

require_safe_absolute_dir "PI_DEPLOY_INSTALL_DIR" "$INSTALL_DIR"
require_safe_absolute_dir "PI_DEPLOY_BIN_DIR" "$BIN_DIR"

cd "$ROOT_DIR"

case "$(uname -s)-$(uname -m)" in
	Linux-x86_64)
		PLATFORM="linux-x64"
		;;
	Linux-aarch64|Linux-arm64)
		PLATFORM="linux-arm64"
		;;
	Darwin-arm64)
		PLATFORM="darwin-arm64"
		;;
	Darwin-x86_64)
		PLATFORM="darwin-x64"
		;;
	*)
		echo "Unsupported deploy platform: $(uname -s)-$(uname -m)" >&2
		exit 1
		;;
esac

npm run check

rm -rf "$TMP_INSTALL_DIR" "$OLD_INSTALL_DIR"
mkdir -p "$(dirname "$INSTALL_DIR")" "$BIN_DIR"

"$ROOT_DIR/scripts/build-binaries.sh" --skip-install --skip-deps --platform "$PLATFORM" --out "$BUILD_DIR"
cp -R "$BUILD_DIR/$PLATFORM" "$TMP_INSTALL_DIR"

if [[ -e "$INSTALL_DIR" || -L "$INSTALL_DIR" ]]; then
	mv "$INSTALL_DIR" "$OLD_INSTALL_DIR"
fi
mv "$TMP_INSTALL_DIR" "$INSTALL_DIR"
rm -rf "$OLD_INSTALL_DIR"

ln -sfn "$INSTALL_DIR/pi" "$BIN_DIR/pi"

"$BIN_DIR/pi" --version
