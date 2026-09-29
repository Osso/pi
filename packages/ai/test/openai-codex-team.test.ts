import { describe, expect, it } from "vitest";
import { InMemoryCredentialStore } from "../src/auth/credential-store.ts";
import { getModels } from "../src/compat.ts";
import { builtinModels } from "../src/providers/all.ts";
import type { AssistantMessage, Context } from "../src/types.ts";
import { getOAuthApiKey, getOAuthProvider } from "../src/utils/oauth/index.ts";

const providerIds = ["openai-codex", "openai-codex-gc", "openai-codex-team"] as const;

function token(accountId: string): string {
	const payload = Buffer.from(
		JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: accountId } }),
	).toString("base64");
	return `header.${payload}.signature`;
}

describe("OpenAI Codex team provider", () => {
	it("registers an independent OAuth identity using the Codex login and refresh flow", async () => {
		const base = getOAuthProvider("openai-codex");
		const gc = getOAuthProvider("openai-codex-gc");
		const team = getOAuthProvider("openai-codex-team");
		expect(team).toBeDefined();
		expect(base?.id).toBe("openai-codex");
		expect(gc?.id).toBe("openai-codex-gc");
		expect(team).toMatchObject({
			id: "openai-codex-team",
			name: "ChatGPT (Codex Subscription, Team)",
			usesCallbackServer: true,
		});

		const credentials = Object.fromEntries(
			providerIds.map((id) => [
				id,
				{ access: `${id}-access`, refresh: `${id}-refresh`, expires: Date.now() + 60000 },
			]),
		);
		for (const id of providerIds) {
			expect((await getOAuthApiKey(id, credentials))?.apiKey).toBe(`${id}-access`);
		}
	});

	it("exposes the identical Codex catalog under its own provider ID", () => {
		const models = builtinModels();
		const team = models.getProvider("openai-codex-team");
		expect(team?.name).toBe("OpenAI Codex (Team)");
		const baseModels = models.getModels("openai-codex");
		const teamModels = models.getModels("openai-codex-team");
		expect(teamModels).toHaveLength(baseModels.length);
		expect(teamModels).toEqual(baseModels.map((model) => ({ ...model, provider: "openai-codex-team" })));
		expect(models.getModel("openai-codex-team", "gpt-6-sol")?.api).toBe("openai-codex-responses");
		expect(getModels("openai-codex-team")).toEqual(
			getModels("openai-codex").map((model) => ({ ...model, provider: "openai-codex-team" })),
		);
	});

	it("resolves team credentials independently without changing existing Codex credentials", async () => {
		const credentials = new InMemoryCredentialStore();
		const models = builtinModels({ credentials });
		for (const id of providerIds) {
			await credentials.modify(id, async () => ({
				type: "oauth",
				access: `${id}-access`,
				refresh: `${id}-refresh`,
				expires: Date.now() + 60000,
			}));
		}
		for (const id of providerIds) {
			const model = models.getModel(id, "gpt-6-sol")!;
			expect(await models.getAuth(model)).toEqual({ auth: { apiKey: `${id}-access` }, source: "OAuth" });
			expect(await credentials.read(id)).toMatchObject({ access: `${id}-access` });
		}
	});

	it("preserves Codex tool-call history in team requests and reports the team provider", async () => {
		const models = builtinModels();
		const model = models.getModel("openai-codex-team", "gpt-6-sol")!;
		const previous: AssistantMessage = {
			role: "assistant",
			api: "openai-codex-responses",
			provider: "openai-codex-team",
			model: model.id,
			content: [{ type: "toolCall", id: "call_1", name: "lookup", arguments: { query: "hello" } }],
			usage: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "toolUse",
			timestamp: 1,
		};
		const context: Context = {
			messages: [
				{ role: "user", content: "look up hello", timestamp: 1 },
				previous,
				{
					role: "toolResult",
					toolCallId: "call_1",
					toolName: "lookup",
					content: [{ type: "text", text: "found" }],
					isError: false,
					timestamp: 2,
				},
			],
		};
		let payload: unknown;
		const result = await models.complete(model, context, {
			apiKey: token("team-account"),
			transport: "sse",
			onPayload: (request) => {
				payload = request;
				throw new Error("request captured before network");
			},
		});
		expect(result.provider).toBe("openai-codex-team");
		expect(result.stopReason).toBe("error");
		expect(payload).toMatchObject({
			model: "gpt-6-sol",
			input: [
				{ role: "user" },
				{ type: "function_call", call_id: "call_1", name: "lookup", arguments: '{"query":"hello"}' },
				{ type: "function_call_output", call_id: "call_1", output: "found" },
			],
		});
	});
});
