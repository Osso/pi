#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
INSTALL_DIR="${PI_DEPLOY_INSTALL_DIR:-$HOME/.local/share/pi}"
BIN_DIR="${PI_DEPLOY_BIN_DIR:-$HOME/.local/bin}"
TMP_INSTALL_DIR="${INSTALL_DIR}.tmp"
OLD_INSTALL_DIR="${INSTALL_DIR}.old"

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

npm run check

rm -rf "$TMP_INSTALL_DIR" "$OLD_INSTALL_DIR"
mkdir -p "$(dirname "$INSTALL_DIR")" "$BIN_DIR"
mkdir -p "$TMP_INSTALL_DIR"
cat > "$TMP_INSTALL_DIR/pi" <<EOF
#!/usr/bin/env bash
set -euo pipefail
exec "$ROOT_DIR/pi-test.sh" "\$@"
EOF
chmod +x "$TMP_INSTALL_DIR/pi"

if [[ -e "$INSTALL_DIR" || -L "$INSTALL_DIR" ]]; then
	mv "$INSTALL_DIR" "$OLD_INSTALL_DIR"
fi
mv "$TMP_INSTALL_DIR" "$INSTALL_DIR"
rm -rf "$OLD_INSTALL_DIR"

ln -sfn "$INSTALL_DIR/pi" "$BIN_DIR/pi"

"$BIN_DIR/pi" --version
