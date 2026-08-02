#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PI_BINARY="${1:-}"
SYSTEMD_USER_DIR="${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user"
SUPERVISOR_TEMPLATE="$ROOT_DIR/packages/coding-agent/systemd/pi-supervisor.service"
SUPERVISOR_UNIT="$SYSTEMD_USER_DIR/pi-supervisor.service"
ARCHITECT_UNIT="$SYSTEMD_USER_DIR/pi-architect.service"

if [[ -z "$PI_BINARY" ]]; then
	echo "Usage: configure-resident-services.sh <pi-binary>" >&2
	exit 1
fi

node "$ROOT_DIR/scripts/validate-systemd-exec-path.mjs" "$PI_BINARY"
mkdir -p "$SYSTEMD_USER_DIR"

XDG_RUNTIME_DIR="${XDG_RUNTIME_DIR:-/run/user/$(id -u)}"
DBUS_SESSION_BUS_ADDRESS="${DBUS_SESSION_BUS_ADDRESS:-unix:path=$XDG_RUNTIME_DIR/bus}"
export XDG_RUNTIME_DIR DBUS_SESSION_BUS_ADDRESS

if systemctl --user cat pi-architect.service >/dev/null 2>&1; then
	systemctl --user disable --now pi-architect.service
fi
rm -f "$ARCHITECT_UNIT"

while IFS= read -r line || [[ -n "$line" ]]; do
	printf '%s\n' "${line//@PI_SUPERVISOR_BINARY@/$PI_BINARY}"
done < "$SUPERVISOR_TEMPLATE" > "$SUPERVISOR_UNIT"
chmod 644 "$SUPERVISOR_UNIT"

systemctl --user daemon-reload
if systemctl --user is-active --quiet pi-architect.service; then
	echo "pi-architect.service is still active" >&2
	exit 1
fi
if systemctl --user is-enabled --quiet pi-architect.service; then
	echo "pi-architect.service is still enabled" >&2
	exit 1
fi

systemctl --user enable --now pi-supervisor.service
systemctl --user restart pi-supervisor.service
systemctl --user is-active --quiet pi-supervisor.service
