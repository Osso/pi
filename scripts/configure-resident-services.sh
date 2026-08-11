#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PI_BINARY="${1:-}"
SUPERVISOR_MODE="${2:-systemd}"
SYSTEMD_USER_DIR="${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user"
ARCHITECT_TEMPLATE="$ROOT_DIR/packages/coding-agent/systemd/pi-architect.service"
ARCHITECT_UNIT="$SYSTEMD_USER_DIR/pi-architect.service"
SUPERVISOR_TEMPLATE="$ROOT_DIR/packages/coding-agent/systemd/pi-supervisor.service"
SUPERVISOR_UNIT="$SYSTEMD_USER_DIR/pi-supervisor.service"

if [[ -z "$PI_BINARY" ]]; then
	echo "Usage: configure-resident-services.sh <pi-binary> [systemd|autostart]" >&2
	exit 1
fi
case "$SUPERVISOR_MODE" in
	systemd | autostart) ;;
	*)
		echo "Supervisor service mode must be systemd or autostart" >&2
		exit 1
		;;
esac

node "$ROOT_DIR/scripts/validate-systemd-exec-path.mjs" "$PI_BINARY"
mkdir -p "$SYSTEMD_USER_DIR"

XDG_RUNTIME_DIR="${XDG_RUNTIME_DIR:-/run/user/$(id -u)}"
DBUS_SESSION_BUS_ADDRESS="${DBUS_SESSION_BUS_ADDRESS:-unix:path=$XDG_RUNTIME_DIR/bus}"
export XDG_RUNTIME_DIR DBUS_SESSION_BUS_ADDRESS

render_unit() {
	local template_path="$1"
	local placeholder="$2"
	local line

	while IFS= read -r line || [[ -n "$line" ]]; do
		printf '%s\n' "${line//$placeholder/$PI_BINARY}"
	done < "$template_path"
}

extract_loaded_unit() {
	local inside_unit=0
	local line

	while IFS= read -r line || [[ -n "$line" ]]; do
		if [[ "$inside_unit" -eq 1 && "$line" == "# /"* ]]; then
			break
		fi
		if [[ "$inside_unit" -eq 0 ]]; then
			if [[ "$line" != "[Unit]" ]]; then
				continue
			fi
			inside_unit=1
		fi
		printf '%s\n' "$line"
	done
}

NEEDS_DAEMON_RELOAD=0

update_unit_file_if_needed() {
	local unit_name="$1"
	local template_path="$2"
	local placeholder="$3"
	local unit_path="$4"
	local desired_unit
	local loaded_output
	local loaded_unit

	desired_unit="$(render_unit "$template_path" "$placeholder")"
	loaded_output="$(systemctl --user cat "$unit_name" --no-pager 2>/dev/null || true)"
	loaded_unit="$(extract_loaded_unit <<< "$loaded_output")"
	if [[ "$loaded_unit" == "$desired_unit" ]]; then
		return
	fi
	printf '%s\n' "$desired_unit" > "$unit_path"
	chmod 644 "$unit_path"
	NEEDS_DAEMON_RELOAD=1
}

remove_supervisor_unit() {
	local loaded_output

	loaded_output="$(systemctl --user cat pi-supervisor.service --no-pager 2>/dev/null || true)"
	if [[ -n "$loaded_output" || -e "$SUPERVISOR_UNIT" ]]; then
		systemctl --user disable --now pi-supervisor.service
	fi
	if [[ -e "$SUPERVISOR_UNIT" ]]; then
		rm -f "$SUPERVISOR_UNIT"
		NEEDS_DAEMON_RELOAD=1
	fi
}

verify_service_enabled() {
	local unit="$1"

	if ! systemctl --user is-active --quiet "$unit"; then
		echo "$unit is not active" >&2
		exit 1
	fi
	if ! systemctl --user is-enabled --quiet "$unit"; then
		echo "$unit is not enabled" >&2
		exit 1
	fi
}

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

update_unit_file_if_needed pi-architect.service "$ARCHITECT_TEMPLATE" @PI_ARCHITECT_BINARY@ "$ARCHITECT_UNIT"
if [[ "$SUPERVISOR_MODE" == "autostart" ]]; then
	remove_supervisor_unit
else
	update_unit_file_if_needed pi-supervisor.service "$SUPERVISOR_TEMPLATE" @PI_SUPERVISOR_BINARY@ "$SUPERVISOR_UNIT"
fi
if [[ "$NEEDS_DAEMON_RELOAD" -eq 1 ]]; then
	systemctl --user daemon-reload
fi

systemctl --user enable --now pi-architect.service
systemctl --user restart pi-architect.service
verify_service_enabled pi-architect.service

if [[ "$SUPERVISOR_MODE" == "autostart" ]]; then
	verify_service_disabled pi-supervisor.service
	exit 0
fi
systemctl --user enable --now pi-supervisor.service
systemctl --user restart pi-supervisor.service
verify_service_enabled pi-supervisor.service
