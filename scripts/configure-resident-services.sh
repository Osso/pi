#!/usr/bin/env bash
# Removes the retired systemd user units of the Architect and Supervisor residents.
# The Architect starts on demand; the Supervisor is an interactive session named by `supervisor.sessionId`.
set -euo pipefail

SYSTEMD_USER_DIR="${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user"

XDG_RUNTIME_DIR="${XDG_RUNTIME_DIR:-/run/user/$(id -u)}"
DBUS_SESSION_BUS_ADDRESS="${DBUS_SESSION_BUS_ADDRESS:-unix:path=$XDG_RUNTIME_DIR/bus}"
export XDG_RUNTIME_DIR DBUS_SESSION_BUS_ADDRESS

verify_service_disabled() {
	local unit="$1"

	if systemctl --user is-active --quiet "$unit"; then
		echo "$unit is still active" >&2
		exit 1
	fi
	if systemctl --user is-enabled --quiet "$unit"; then
		echo "$unit is still enabled" >&2
		exit 1
	fi
}

for unit in pi-architect.service pi-supervisor.service; do
	if systemctl --user cat "$unit" >/dev/null 2>&1 || [[ -e "$SYSTEMD_USER_DIR/$unit" ]]; then
		systemctl --user disable --now "$unit"
	fi
	rm -f "$SYSTEMD_USER_DIR/$unit"
done
systemctl --user daemon-reload
verify_service_disabled pi-architect.service
verify_service_disabled pi-supervisor.service
