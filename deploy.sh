#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
INSTALL_DIR="${PI_DEV_INSTALL_DIR:-$HOME/.local/share/pi-dev}"
BIN_DIR="${PI_DEV_BIN_DIR:-$HOME/.local/bin}"
TMP_INSTALL_DIR="${INSTALL_DIR}.tmp"
OLD_INSTALL_DIR="${INSTALL_DIR}.old"
BIN_NAME="${PI_DEV_BIN_NAME:-pi-dev}"

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

rollback_install_on_failure() {
	local status="$1"

	if [[ "$status" -ne 0 ]]; then
		if [[ "$DEPLOY_REPLACED_INSTALL" -eq 1 ]]; then
			rm -rf "$INSTALL_DIR"
			if [[ -e "$OLD_INSTALL_DIR" || -L "$OLD_INSTALL_DIR" ]]; then
				mv "$OLD_INSTALL_DIR" "$INSTALL_DIR"
			fi
		fi
		rm -rf "$TMP_INSTALL_DIR" "$OLD_INSTALL_DIR"
	fi
}

on_exit() {
	local status="$?"
	rollback_install_on_failure "$status"
	exit "$status"
}

require_safe_absolute_dir "PI_DEV_INSTALL_DIR" "$INSTALL_DIR"
require_safe_absolute_dir "PI_DEV_BIN_DIR" "$BIN_DIR"

cd "$ROOT_DIR"
DEPLOY_REPLACED_INSTALL=0
trap on_exit EXIT

npm run check

rm -rf "$TMP_INSTALL_DIR" "$OLD_INSTALL_DIR"
mkdir -p "$(dirname "$INSTALL_DIR")" "$BIN_DIR" "$TMP_INSTALL_DIR"

cat > "$TMP_INSTALL_DIR/pi" <<EOF
#!/usr/bin/env bash
set -euo pipefail

exec env \
	-u PI_RESTART_EXIT_CODE \
	-u PI_RESTART_REQUEST_FILE \
	-u PI_SELF_RESTART_SESSION \
	-u PI_SELF_RESTART_PROMPT \
	-u PI_SELF_RESTART_OLD_PID \
	"PI_EXECUTABLE_NAME=$BIN_NAME" \
	"$ROOT_DIR/pi-test.sh" "\$@"
EOF
chmod +x "$TMP_INSTALL_DIR/pi"

if [[ -e "$INSTALL_DIR" || -L "$INSTALL_DIR" ]]; then
	mv "$INSTALL_DIR" "$OLD_INSTALL_DIR"
fi
mv "$TMP_INSTALL_DIR" "$INSTALL_DIR"
DEPLOY_REPLACED_INSTALL=1

ln -sfn "$INSTALL_DIR/pi" "$BIN_DIR/$BIN_NAME"

"$BIN_DIR/$BIN_NAME" --version
rm -rf "$OLD_INSTALL_DIR"
