#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
INSTALL_DIR="${PI_DEPLOY_INSTALL_DIR:-$HOME/.local/share/pi}"
BIN_DIR="${PI_DEPLOY_BIN_DIR:-$HOME/.local/bin}"
TMP_INSTALL_DIR="${INSTALL_DIR}.tmp"
OLD_INSTALL_DIR="${INSTALL_DIR}.old"
BUILD_DIR="${PI_DEPLOY_BUILD_DIR:-$ROOT_DIR/packages/coding-agent/binaries}"
DEFER_ARCHITECT_RESTART="${PI_DEPLOY_DEFER_ARCHITECT_RESTART:-0}"

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

render_architect_service_unit() {
	local output_path="$1"
	local line

	while IFS= read -r line || [[ -n "$line" ]]; do
		printf '%s\n' "${line//@PI_ARCHITECT_BINARY@/$BIN_DIR/pi}"
	done < "$ROOT_DIR/packages/coding-agent/systemd/pi-architect.service" > "$output_path"
}

cleanup_extension_build_outputs() {
	shopt -s globstar nullglob
	rm -f \
		packages/coding-agent/extensions/**/src/*.js \
		packages/coding-agent/extensions/**/src/*.js.map \
		packages/coding-agent/extensions/**/src/*.d.ts \
		packages/coding-agent/extensions/**/src/*.d.ts.map
	shopt -u globstar nullglob
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
	cleanup_extension_build_outputs
	rollback_install_on_failure "$status"
	exit "$status"
}

require_safe_absolute_dir "PI_DEPLOY_INSTALL_DIR" "$INSTALL_DIR"
require_safe_absolute_dir "PI_DEPLOY_BIN_DIR" "$BIN_DIR"

cd "$ROOT_DIR"
DEPLOY_REPLACED_INSTALL=0
trap on_exit EXIT

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

npm --prefix packages/tui run clean
npm --prefix packages/tui run build
npm --prefix packages/ai run clean
npm --prefix packages/ai exec -- tsgo -p packages/ai/tsconfig.build.json
npm --prefix packages/agent-core run clean
npm --prefix packages/agent-core run build
npm --prefix packages/coding-agent run clean
npm --prefix packages/coding-agent run build

"$ROOT_DIR/scripts/build-binaries.sh" --skip-install --skip-deps --skip-build --platform "$PLATFORM" --out "$BUILD_DIR"
cp -R "$BUILD_DIR/$PLATFORM" "$TMP_INSTALL_DIR"

if [[ -e "$INSTALL_DIR" || -L "$INSTALL_DIR" ]]; then
	mv "$INSTALL_DIR" "$OLD_INSTALL_DIR"
fi
mv "$TMP_INSTALL_DIR" "$INSTALL_DIR"
DEPLOY_REPLACED_INSTALL=1

ln -sfn "$INSTALL_DIR/pi" "$BIN_DIR/pi"

"$BIN_DIR/pi" --version
SYSTEMD_USER_DIR="${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user"
mkdir -p "$SYSTEMD_USER_DIR"
render_architect_service_unit "$SYSTEMD_USER_DIR/pi-architect.service"
chmod 644 "$SYSTEMD_USER_DIR/pi-architect.service"
systemctl --user daemon-reload
if [[ "$DEFER_ARCHITECT_RESTART" == "1" ]]; then
	echo "Architect restart deferred until lifecycle protocol migration completes."
else
	systemctl --user enable --now pi-architect.service
	systemctl --user restart pi-architect.service
	systemctl --user is-active --quiet pi-architect.service
fi
rm -rf "$OLD_INSTALL_DIR"
