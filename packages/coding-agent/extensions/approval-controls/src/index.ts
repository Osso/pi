import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import {
	isSandboxProfileName,
	type SandboxProfileName,
	type SandboxProfileScope,
} from "../../../src/core/permissions/presets.ts";

const SANDBOX_USAGE =
	"Usage: /sandbox [read-only|workspace-write|full-access|inherit] [session|project|global]";

type SandboxCommandSelection = {
	profile: SandboxProfileName | undefined;
	scope: SandboxProfileScope;
};

function parseSandboxSelection(args: string): SandboxCommandSelection | undefined {
	const [profileArgument, scopeArgument, extraArgument] = args.trim().toLowerCase().split(/\s+/);
	if (!profileArgument || !scopeArgument || extraArgument) return undefined;
	if (scopeArgument !== "session" && scopeArgument !== "project" && scopeArgument !== "global") return undefined;
	if (profileArgument === "inherit") {
		return scopeArgument === "session" ? { profile: undefined, scope: "session" } : undefined;
	}
	return isSandboxProfileName(profileArgument) ? { profile: profileArgument, scope: scopeArgument } : undefined;
}

function clearEditor(ctx: ExtensionCommandContext): void {
	ctx.ui.setEditorText("");
}

async function handleSandboxCommand(args: string, ctx: ExtensionCommandContext): Promise<void> {
	if (!args.trim()) {
		ctx.showSandboxSelector();
		clearEditor(ctx);
		return;
	}
	const selection = parseSandboxSelection(args);
	if (!selection) {
		ctx.ui.notify(SANDBOX_USAGE, "warning");
		clearEditor(ctx);
		return;
	}
	ctx.setSandboxProfile(selection.profile, selection.scope);
	ctx.ui.notify(`Sandbox profile: ${selection.profile ?? "inherit"} (${selection.scope})`, "info");
	clearEditor(ctx);
}

export default function approvalControlsExtension(pi: ExtensionAPI): void {
	pi.registerCommand("approvals", {
		description: "Select approval preset",
		handler: async (_args: string, ctx: ExtensionCommandContext) => {
			ctx.showApprovalSelector();
			clearEditor(ctx);
		},
	});

	pi.registerCommand("sandbox", {
		description: "Select or set sandbox profile",
		handler: handleSandboxCommand,
	});
}
