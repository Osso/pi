import { createServer, type IncomingMessage } from "node:http";
import type { Model } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import {
	buildOpenAICompactPayload,
	extractOpenAICompactDetails,
	handleCompaction,
} from "../extensions/openai-remote-compact/src/index.ts";
import { AuthStorage } from "../src/core/auth-storage.ts";
import type { CompactionEvent, ExtensionContext } from "../src/core/extensions/types.ts";
import { ModelRegistry } from "../src/core/model-registry.ts";

function createAccountToken(accountId: string): string {
	const payload = { "https://api.openai.com/auth": { chatgpt_account_id: accountId } };
	return `header.${Buffer.from(JSON.stringify(payload)).toString("base64url")}.signature`;
}

interface CapturedCompactRequest {
	url: string | undefined;
	account: string | string[] | undefined;
	authorization: string | undefined;
	payload: unknown;
}

async function readCompactRequest(request: IncomingMessage): Promise<CapturedCompactRequest> {
	const chunks: Buffer[] = [];
	for await (const chunk of request) chunks.push(Buffer.from(chunk));
	return {
		url: request.url,
		account: request.headers["chatgpt-account-id"],
		authorization: request.headers.authorization,
		payload: JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown,
	};
}

async function startCompactServer(nativeHistory: Array<Record<string, unknown>>) {
	const requests: CapturedCompactRequest[] = [];
	const server = createServer(async (request, response) => {
		requests.push(await readCompactRequest(request));
		response.writeHead(200, { "content-type": "application/json" });
		response.end(JSON.stringify({ output: nativeHistory }));
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const address = server.address();
	if (!address || typeof address === "string") throw new Error("Missing HTTP fixture address");
	return {
		baseUrl: `http://127.0.0.1:${address.port}`,
		requests,
		close: () => new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve()))),
	};
}

function createCodexModel(overrides: Partial<Model<"openai-codex-responses">> = {}): Model<"openai-codex-responses"> {
	return {
		id: "gpt-5.6-luna",
		name: "Session model",
		provider: "openai-codex",
		api: "openai-codex-responses",
		baseUrl: "https://chatgpt.com/backend-api",
		reasoning: true,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 922000,
		maxTokens: 32000,
		...overrides,
	};
}

describe("remote compaction session model alignment", () => {
	it.each([
		{ provider: "openai-codex", id: "gpt-6-astra" },
		{ provider: "openai-codex", id: "gpt-5.6-luna" },
		{ provider: "openai-codex-gc", id: "gpt-6-astra" },
		{ provider: "openai-codex-gc", id: "gpt-5.6-luna" },
	])("uses the active $provider/$id model for compaction", ({ provider, id }) => {
		const model = createCodexModel({ provider, id });
		const payload = buildOpenAICompactPayload(model, [], "system prompt", []);
		const details = extractOpenAICompactDetails(
			model,
			{ output: [{ type: "compaction", encrypted_content: "encrypted" }] },
			"https://chatgpt.com/backend-api/codex/responses/compact",
		);

		expect(payload.model).toBe(id);
		expect(details.model).toBe(id);
		expect(details.provider).toBe(provider);
	});

	it.each(["openai-codex", "openai-codex-gc"])(
		"uses the current %s model and account while preserving native history",
		async (provider) => {
			const nativeHistory = [{ type: "compaction", encrypted_content: "retained-native-context" }];
			const server = await startCompactServer(nativeHistory);
			const requests = server.requests;
			try {
				let model = createCodexModel({ provider, baseUrl: server.baseUrl });
				const authStorage = AuthStorage.inMemory();
				for (const account of ["openai-codex", "openai-codex-gc"]) {
					authStorage.setRuntimeApiKey(account, createAccountToken(account));
				}
				const ctx = {
					get model() {
						return model;
					},
					modelRegistry: ModelRegistry.inMemory(authStorage),
					getSystemPrompt: () => "Keep the current task and its native context.",
					ui: {
						notify: (message: string) => {
							throw new Error(message);
						},
					},
				} as unknown as ExtensionContext;
				const event: CompactionEvent = {
					type: "compaction",
					preparation: {
						fileOps: { read: new Set(), written: new Set(), edited: new Set() },
						firstKeptEntryId: "kept-message",
						isSplitTurn: false,
						messagesToSummarize: [{ role: "user", content: "Current task", timestamp: 1 }],
						settings: { enabled: true, keepRecentTokens: 1, reserveTokens: 1 },
						tokensBefore: 700000,
						turnPrefixMessages: [],
					},
					branchEntries: [],
					reason: "threshold",
					willRetry: false,
					signal: new AbortController().signal,
				};
				const first = await handleCompaction(event, ctx);
				if (!first) throw new Error("Remote compaction did not handle the session model");
				event.branchEntries.push({
					type: "compaction",
					id: "previous-compaction",
					parentId: null,
					timestamp: "2026-09-16T00:00:00Z",
					...first.compaction,
				});
				model = { ...model, id: "gpt-6-astra" };
				const second = await handleCompaction(event, ctx);

				expect(requests).toHaveLength(2);
				for (const request of requests) {
					expect(request.url).toBe("/codex/responses/compact");
					expect(request.account).toBe(provider);
					expect(request.authorization).toBe(`Bearer ${createAccountToken(provider)}`);
				}
				expect(requests[0].payload).toMatchObject({ model: "gpt-5.6-luna" });
				expect(requests[1].payload).toMatchObject({
					model: "gpt-6-astra",
					input: [...nativeHistory, { role: "user", content: [{ type: "input_text", text: "Current task" }] }],
				});
				expect(second?.compaction).toMatchObject({
					source: { provider, model: "gpt-6-astra" },
					details: { provider, model: "gpt-6-astra", replacementHistory: nativeHistory },
					providerNative: { provider, api: model.api, value: nativeHistory },
				});
				expect(ctx.model).toBe(model);
			} finally {
				await server.close();
			}
		},
	);
});
