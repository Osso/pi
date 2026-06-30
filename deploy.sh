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

SCRIPT_DIR="$ROOT_DIR"
NO_ENV=false
ARGS=()
for arg in "\$@"; do
	if [[ "\$arg" == "--no-env" ]]; then
		NO_ENV=true
	else
		ARGS+=("\$arg")
	fi
done

if [[ "\$NO_ENV" == "true" ]]; then
	unset ANTHROPIC_API_KEY
	unset ANTHROPIC_OAUTH_TOKEN
	unset OPENAI_API_KEY
	unset GEMINI_API_KEY
	unset GROQ_API_KEY
	unset CEREBRAS_API_KEY
	unset XAI_API_KEY
	unset OPENROUTER_API_KEY
	unset ZAI_API_KEY
	unset MISTRAL_API_KEY
	unset MINIMAX_API_KEY
	unset MINIMAX_CN_API_KEY
	unset AI_GATEWAY_API_KEY
	unset OPENCODE_API_KEY
	unset COPILOT_GITHUB_TOKEN
	unset GH_TOKEN
	unset GITHUB_TOKEN
	unset HF_TOKEN
	unset GOOGLE_APPLICATION_CREDENTIALS
	unset GOOGLE_CLOUD_PROJECT
	unset GCLOUD_PROJECT
	unset GOOGLE_CLOUD_LOCATION
	unset AWS_PROFILE
	unset AWS_ACCESS_KEY_ID
	unset AWS_SECRET_ACCESS_KEY
	unset AWS_SESSION_TOKEN
	unset AWS_REGION
	unset AWS_DEFAULT_REGION
	unset AWS_BEARER_TOKEN_BEDROCK
	unset AWS_CONTAINER_CREDENTIALS_RELATIVE_URI
	unset AWS_CONTAINER_CREDENTIALS_FULL_URI
	unset AWS_WEB_IDENTITY_TOKEN_FILE
	unset AZURE_OPENAI_API_KEY
	unset AZURE_OPENAI_BASE_URL
	unset AZURE_OPENAI_RESOURCE_NAME
	echo "Running without API keys..."
fi

exec env \
	-u PI_SELF_RESTART_SESSION \
	-u PI_SELF_RESTART_PROMPT \
	-u PI_SELF_RESTART_OLD_PID \
	"PI_EXECUTABLE_NAME=$BIN_NAME" \
	"\$SCRIPT_DIR/node_modules/.bin/tsx" \
	--tsconfig "\$SCRIPT_DIR/tsconfig.json" \
	"\$SCRIPT_DIR/packages/coding-agent/src/cli.ts" \
	"\${ARGS[@]}"
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
