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

RESTART_EXIT_CODE=75
RESTART_REQUEST_FILE="\$(mktemp -t pi-dev-restart.XXXXXX)"
NEXT_SESSION=""
NEXT_PROMPT=""

cleanup() {
	rm -f "\$RESTART_REQUEST_FILE"
}
trap cleanup EXIT

while true; do
	: > "\$RESTART_REQUEST_FILE"
	env_args=(
		"PI_RESTART_EXIT_CODE=\$RESTART_EXIT_CODE"
		"PI_RESTART_REQUEST_FILE=\$RESTART_REQUEST_FILE"
	)
	if [[ -n "\$NEXT_SESSION" ]]; then
		env_args+=("PI_SELF_RESTART_SESSION=\$NEXT_SESSION")
		env_args+=("PI_SELF_RESTART_PROMPT=\$NEXT_PROMPT")
		NEXT_SESSION=""
		NEXT_PROMPT=""
	fi

	set +e
	env "\${env_args[@]}" "$ROOT_DIR/pi-test.sh" "\$@"
	exit_code="\$?"
	set -e
	if [[ "\$exit_code" -ne "\$RESTART_EXIT_CODE" ]]; then
		exit "\$exit_code"
	fi
	if [[ ! -s "\$RESTART_REQUEST_FILE" ]]; then
		continue
	fi
	readarray -d '' restart_values < <(
		node -e 'const fs = require("node:fs"); const request = JSON.parse(fs.readFileSync(process.argv[1], "utf8")); process.stdout.write(String(request.sessionFile ?? "")); process.stdout.write("\0"); process.stdout.write(String(request.prompt ?? "")); process.stdout.write("\0");' "\$RESTART_REQUEST_FILE"
	)
	NEXT_SESSION="\${restart_values[0]}"
	NEXT_PROMPT="\${restart_values[1]-}"
done
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
