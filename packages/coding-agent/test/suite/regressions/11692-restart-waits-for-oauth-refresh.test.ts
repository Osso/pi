import { registerOAuthProvider } from "@earendil-works/pi-ai/oauth";
import { describe, expect, it } from "vitest";
import {
	AgentSessionRuntime,
	type AgentSessionServices,
	type CreateAgentSessionRuntimeFactory,
} from "../../../src/core/agent-session-runtime.ts";
import { AuthStorage } from "../../../src/core/auth-storage.ts";
import { createHarness } from "../harness.ts";

const providerId = "rotating-oauth-11692";

// Upstream #11692: the token endpoint spends the old single-use refresh token as soon as it answers. A process
// restart (execve) or exit before the new token is saved left only the spent one in auth.json.
describe("OAuth refresh in flight at process restart", () => {
	it("hands off to the new process only after the rotated token is saved", async () => {
		let markRefreshStarted!: () => void;
		const refreshStarted = new Promise<void>((resolve) => {
			markRefreshStarted = resolve;
		});
		let respond!: () => void;
		const response = new Promise<void>((resolve) => {
			respond = resolve;
		});
		registerOAuthProvider({
			id: providerId,
			name: "Rotating OAuth",
			async login() {
				throw new Error("unused");
			},
			async refreshToken() {
				markRefreshStarted();
				await response;
				return { access: "new-access", refresh: "new-refresh", expires: Date.now() + 3_600_000 };
			},
			getApiKey: (credentials) => credentials.access,
		});
		const authStorage = AuthStorage.inMemory({
			[providerId]: { type: "oauth", access: "old-access", refresh: "old-refresh", expires: Date.now() - 1000 },
		});
		const harness = await createHarness({ persistedSession: true });
		const services: AgentSessionServices = {
			cwd: harness.tempDir,
			agentDir: harness.tempDir,
			authStorage,
			settingsManager: harness.settingsManager,
			modelRegistry: harness.session.modelRegistry,
			resourceLoader: harness.session.resourceLoader,
			diagnostics: [],
		};
		const unusedFactory: CreateAgentSessionRuntimeFactory = async () => {
			throw new Error("runtime replacement is not used in this test");
		};
		const runtime = new AgentSessionRuntime(harness.session, services, unusedFactory);
		let refreshAtHandoff: unknown;
		runtime.setProcessRestarter(async () => {
			refreshAtHandoff = authStorage.get(providerId);
			throw new Error("process restart requested");
		});
		try {
			const apiKey = authStorage.getApiKey(providerId);
			await refreshStarted;
			const restarting = runtime.restart({ process: true });
			await new Promise((resolve) => setTimeout(resolve, 20));
			expect(refreshAtHandoff).toBeUndefined();

			respond();
			await expect(restarting).rejects.toThrow("process restart requested");
			expect(refreshAtHandoff).toMatchObject({ access: "new-access", refresh: "new-refresh" });
			expect(await apiKey).toBe("new-access");
		} finally {
			harness.cleanup();
		}
	});
});
