import { describe, expect, it, vi } from "vitest";
import type { AgentSession } from "../src/core/agent-session.ts";
import { LoginFlow, type LoginFlowHost } from "../src/modes/interactive/login-flow.ts";

function createHost(authStorage: { getOAuthProviders(): { id: string; name: string }[]; list(): string[] }) {
	const showStatus = vi.fn();
	const showSelector = vi.fn();
	const host = {
		session: { modelRegistry: { authStorage } } as unknown as AgentSession,
		showStatus,
		showSelector,
	} as unknown as LoginFlowHost;
	return { flow: new LoginFlow(host), showSelector, showStatus };
}

describe("LoginFlow", () => {
	it("explains that /logout has nothing to remove when no credentials are stored", async () => {
		const { flow, showSelector, showStatus } = createHost({ getOAuthProviders: () => [], list: () => [] });

		await flow.showOAuthSelector("logout");

		expect(showStatus).toHaveBeenCalledWith(
			"No stored credentials to remove. /logout only removes credentials saved by /login; environment variables and models.json config are unchanged.",
		);
		expect(showSelector).not.toHaveBeenCalled();
	});

	it("reports an unknown provider passed to /login", async () => {
		const { flow, showStatus } = createHost({
			getOAuthProviders: () => [{ id: "openai-codex", name: "ChatGPT" }],
			list: () => [],
		});

		await flow.handleLoginCommand("no-such-provider");

		expect(showStatus).toHaveBeenCalledWith("Unknown OAuth provider: no-such-provider");
	});
});
