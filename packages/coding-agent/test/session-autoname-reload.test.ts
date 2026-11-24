import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage, fauxToolCall, registerFauxProvider } from "@earendil-works/pi-ai/compat";
import { afterEach, describe, expect, it } from "vitest";
import sessionAutonameExtension from "../extensions/session-autoname/src/index.ts";
import {
	type CreateAgentSessionRuntimeFactory,
	createAgentSessionFromServices,
	createAgentSessionRuntime,
	createAgentSessionServices,
} from "../src/core/agent-session-runtime.ts";
import { AuthStorage } from "../src/core/auth-storage.ts";
import { getControlDbPath } from "../src/core/session-control-db.ts";
import { SessionManager } from "../src/core/session-manager.ts";

const cleanups: Array<() => Promise<void> | void> = [];

afterEach(async () => {
	for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function createRuntimeHost() {
	const tempDir = join(tmpdir(), `pi-autoname-reload-${Date.now()}-${Math.random().toString(36).slice(2)}`);
	mkdirSync(tempDir, { recursive: true });
	const faux = registerFauxProvider();
	const authStorage = AuthStorage.inMemory();
	authStorage.setRuntimeApiKey(faux.getModel().provider, "faux-key");
	// The real resource loader runs extension factories again on reload, creating a new extension instance.
	const createRuntime: CreateAgentSessionRuntimeFactory = async ({ cwd, sessionManager, sessionStartEvent }) => {
		const services = await createAgentSessionServices({
			agentDir: tempDir,
			authStorage,
			cwd,
			resourceLoaderOptions: {
				extensionFactories: [sessionAutonameExtension],
				noSkills: true,
				noPromptTemplates: true,
				noThemes: true,
			},
		});
		return {
			...(await createAgentSessionFromServices({
				services,
				sessionManager,
				sessionStartEvent,
				model: faux.getModel(),
			})),
			services,
			diagnostics: services.diagnostics,
		};
	};
	const sessionManager = SessionManager.create(tempDir, join(tempDir, "sessions"));
	sessionManager.setMetadataControlDbPath(getControlDbPath(tempDir));
	const runtimeHost = await createAgentSessionRuntime(createRuntime, {
		cwd: tempDir,
		agentDir: tempDir,
		sessionManager,
	});
	await runtimeHost.session.bindExtensions({});
	cleanups.push(async () => {
		await runtimeHost.dispose();
		faux.unregister();
		rmSync(tempDir, { recursive: true, force: true });
	});
	return { faux, runtimeHost };
}

describe("session naming tool across reload", () => {
	it("lets the tool correct the name it set before an extension reload", async () => {
		const { faux, runtimeHost } = await createRuntimeHost();
		faux.setResponses([
			fauxAssistantMessage(fauxToolCall("set_session_name", { name: "First Title" }), { stopReason: "toolUse" }),
			fauxAssistantMessage("named"),
		]);
		await runtimeHost.session.prompt("Name the session");
		expect(runtimeHost.session.sessionManager.getSessionName()).toBe("First Title");

		await runtimeHost.session.reload();
		const reloadedTool = runtimeHost.session.getToolDefinition("set_session_name");
		if (!reloadedTool) throw new Error("Expected set_session_name after reload");
		const result = await reloadedTool.execute(
			"correct-after-reload",
			{ name: "Corrected Title" },
			undefined,
			undefined,
			runtimeHost.session.extensionRunner.createContext(),
		);

		expect(result.isError).toBeFalsy();
		expect(runtimeHost.session.sessionManager.getSessionName()).toBe("Corrected Title");
	});
});
