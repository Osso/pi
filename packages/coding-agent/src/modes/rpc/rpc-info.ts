import { getChangelogPath } from "../../config.ts";
import type { AgentSession } from "../../core/agent-session.ts";
import type { AgentSessionRuntime } from "../../core/agent-session-runtime.ts";
import { KeybindingsManager } from "../../core/keybindings.ts";
import { resolveModelScope } from "../../core/model-resolver.ts";
import { ProjectTrustStore } from "../../core/trust-manager.ts";
import { normalizeChangelogLinks, parseChangelog } from "../../utils/changelog.ts";
import { resolvePath } from "../../utils/paths.ts";
import { createSessionGist } from "../interactive/share-gist.ts";
import type { RpcInfoCommand, RpcResponse } from "./rpc-types.ts";

export function isRpcInfoCommand(command: { type: string }): command is RpcInfoCommand {
	return [
		"get_tools",
		"get_extensions",
		"get_changelog",
		"share_session",
		"get_keybindings",
		"get_scoped_models",
		"set_scoped_models",
		"clear_session_name",
		"continue",
		"reload",
		"import_session",
		"set_cwd",
		"get_project_trust",
		"set_project_trust",
	].includes(command.type);
}

export async function handleRpcInfoCommand(
	command: RpcInfoCommand,
	session: AgentSession,
	runtimeHost: AgentSessionRuntime,
): Promise<RpcResponse> {
	const { id, type } = command;
	if (type === "clear_session_name") {
		session.clearSessionName();
		return { id, type: "response", command: type, success: true };
	}
	if (type === "continue") {
		if (session.isStreaming) {
			if (session.pendingMessageCount > 0) await session.interrupt("", "rpc");
			else await session.abort();
			return { id, type: "response", command: type, success: true };
		}
		if (session.isCompacting) {
			return { id, type: "response", command: type, success: false, error: "Session is busy" };
		}
		await session.continue();
		return { id, type: "response", command: type, success: true };
	}
	if (type === "reload") {
		if (session.isStreaming || session.isCompacting) {
			return { id, type: "response", command: type, success: false, error: "Session is busy" };
		}
		await runtimeHost.reload();
		return { id, type: "response", command: type, success: true };
	}
	if (type === "import_session") {
		if (!command.path.trim())
			return { id, type: "response", command: type, success: false, error: "path must be a non-empty string" };
		const result = await runtimeHost.importFromJsonl(command.path);
		return { id, type: "response", command: type, success: true, data: result };
	}
	if (type === "set_cwd") {
		if (!command.cwd.trim())
			return { id, type: "response", command: type, success: false, error: "cwd must be a non-empty string" };
		await runtimeHost.relocate(resolvePath(command.cwd, session.sessionManager.getCwd()));
		return { id, type: "response", command: type, success: true, data: { cwd: runtimeHost.cwd } };
	}
	if (type === "get_project_trust" || type === "set_project_trust") {
		const agentDir = runtimeHost.services.agentDir;
		if (!agentDir)
			return { id, type: "response", command: type, success: false, error: "Project trust is unavailable" };
		const cwd = session.sessionManager.getCwd();
		const store = new ProjectTrustStore(agentDir);
		if (type === "set_project_trust") store.set(cwd, command.trusted);
		const entry = store.getEntry(cwd);
		return {
			id,
			type: "response",
			command: type,
			success: true,
			data: { cwd, decision: entry?.decision ?? null, path: entry?.path ?? null },
		};
	}
	if (type === "share_session") {
		const { url } = await createSessionGist(session);
		return { id, type: "response", command: type, success: true, data: { url } };
	}
	if (type === "get_scoped_models" || type === "set_scoped_models") {
		if (type === "set_scoped_models") {
			if (!Array.isArray(command.models) || command.models.some((model) => typeof model !== "string")) {
				return {
					id,
					type: "response",
					command: type,
					success: false,
					error: "models must be an array of model IDs",
				};
			}
			const resolved = await resolveModelScope(command.models, session.modelRegistry);
			session.setScopedModels(resolved.map(({ model, thinkingLevel }) => ({ model, thinkingLevel })));
		}
		const models = session.scopedModels.map(({ model, thinkingLevel }) => ({
			provider: model.provider,
			id: model.id,
			thinkingLevel,
		}));
		return { id, type: "response", command: type, success: true, data: { models } };
	}
	if (type === "get_keybindings") {
		const keybindings = KeybindingsManager.create(runtimeHost.services.agentDir).getEffectiveConfig();
		const shortcuts = session.extensionRunner.getShortcuts(keybindings);
		return {
			id,
			type: "response",
			command: type,
			success: true,
			data: { keybindings, shortcuts: Object.fromEntries(shortcuts) },
		};
	}
	if (type === "get_tools") {
		const activeTools = new Set(session.getActiveToolNames());
		const tools = session
			.getAllTools()
			.filter((tool) => activeTools.has(tool.name))
			.map(({ name, description }) => ({ name, description }));
		return { id, type: "response", command: type, success: true, data: { tools } };
	}
	if (type === "get_extensions") {
		const { extensions, errors } = session.resourceLoader.getExtensions();
		return {
			id,
			type: "response",
			command: type,
			success: true,
			data: {
				extensions: extensions.map(({ path }) => ({ path })),
				errors: errors.map(({ path, error }) => ({ path, error })),
			},
		};
	}
	const entries = parseChangelog(getChangelogPath());
	const changelog =
		entries.length > 0
			? entries
					.reverse()
					.map((entry) => normalizeChangelogLinks(entry.content, entry))
					.join("\n\n")
			: "No changelog entries found.";
	return { id, type: "response", command: type, success: true, data: { changelog } };
}
