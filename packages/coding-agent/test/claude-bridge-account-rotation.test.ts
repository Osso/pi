import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import bridge, { __test } from "../extensions/claude-bridge/src/index.ts";
import { AuthStorage } from "../src/core/auth-storage.ts";
import { DefaultResourceLoader } from "../src/core/resource-loader.ts";
import { createAgentSession } from "../src/core/sdk.ts";
import { SessionManager } from "../src/core/session-manager.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";

let root: string | undefined;
afterEach(() => {
	__test.setQuery(null);
	__test.setIsolatedQuery(null);
	__test.resetSharedSession();
	__test.resetAccountProfiles();
	vi.unstubAllEnvs();
	if (root) rmSync(root, { recursive: true, force: true });
	root = undefined;
});

const weeklyLimit = "You've hit your weekly limit · resets Nov 12, 10am (America/Chicago)";

/** What Claude Code emits for a subscription quota rejection: a rejected rate-limit event,
 *  a `<synthetic>` report, an error result, and then the SDK throws because the CLI exits. */
async function* quotaRejectedQuery() {
	yield {
		type: "rate_limit_event",
		rate_limit_info: { status: "rejected", rateLimitType: "seven_day", resetsAt: Date.now() / 1000 + 86_400 },
	};
	yield { type: "assistant", message: { model: "<synthetic>", content: [{ type: "text", text: weeklyLimit }] } };
	yield { type: "result", subtype: "success", is_error: true, result: weeklyLimit };
	throw new Error(`Claude Code returned an error result: ${weeklyLimit}`);
}

async function* servedQuery() {
	yield {
		type: "assistant",
		message: {
			content: [{ type: "text", text: "Served on the next account." }],
			usage: { input_tokens: 1, output_tokens: 1 },
		},
	};
	yield { type: "result", subtype: "success", is_error: false, result: "Served on the next account." };
}

/** Profiles alpha (active) and beta with valid saved logins; returns each profile's config dir. */
function setUpProfiles(): { agentDir: string; profileDir: (name: string) => string } {
	const dir = mkdtempSync(join(tmpdir(), "pi-claude-account-rotation-"));
	root = dir;
	const agentDir = join(dir, "agent");
	const claudeDir = join(dir, ".claude");
	mkdirSync(agentDir);
	mkdirSync(claudeDir);
	vi.stubEnv("HOME", dir);
	vi.stubEnv("USERPROFILE", dir);
	vi.stubEnv("CLAUDE_CONFIG_DIR", claudeDir);
	vi.stubEnv("PI_CODING_AGENT_DIR", agentDir);
	for (const name of ["alpha", "beta"]) {
		writeFileSync(
			join(claudeDir, `${name}.credentials.json`),
			JSON.stringify({ claudeAiOauth: { accessToken: name } }),
		);
	}
	writeFileSync(join(claudeDir, ".active-profile"), "alpha");
	writeFileSync(
		join(agentDir, "claude-bridge.json"),
		JSON.stringify({ provider: { accountProfiles: ["alpha", "beta"] } }),
	);
	return { agentDir, profileDir: (name) => join(dir, ".config", "pi-claude-bridge", "profiles", name) };
}

/** Prompts one Pi session on the bridge; returns its first reply, Pi retries, and the config dir of each query. */
async function promptBridge(agentDir: string, queryFor: (attempt: number) => AsyncGenerator<unknown>) {
	const cwd = root as string;
	const configDirs: string[] = [];
	__test.setQuery((({ options }: { options: { env: Record<string, string> } }) => {
		configDirs.push(options.env.CLAUDE_CONFIG_DIR);
		return Object.assign(queryFor(configDirs.length), { interrupt: async () => {}, close: () => {} });
	}) as never);

	const settingsManager = SettingsManager.inMemory({ retry: { enabled: true, baseDelayMs: 60_000 } });
	const resourceLoader = new DefaultResourceLoader({
		cwd,
		agentDir,
		settingsManager,
		extensionFactories: [Object.assign(bridge, { extensionPath: "<first-party:claude-bridge>" })],
		noExtensions: true,
		noSkills: true,
		noPromptTemplates: true,
		noThemes: true,
	});
	await resourceLoader.reload();
	const { session } = await createAgentSession({
		cwd,
		agentDir,
		settingsManager,
		resourceLoader,
		authStorage: AuthStorage.inMemory(),
		sessionManager: SessionManager.inMemory(),
	});
	const retries: unknown[] = [];
	session.subscribe((event) => {
		if (event.type === "auto_retry_start") retries.push(event);
	});
	try {
		await session.bindExtensions({});
		const model = session.modelRegistry.getAll().find((entry) => entry.provider === "claude-bridge");
		if (!model) throw new Error("Bundled Claude provider did not register");
		await session.setModel(model);
		await session.prompt("Answer on whichever account works.");
		// The first reply answers the prompt; later turns are Pi's end_turn continuation.
		return { reply: session.messages.find((message) => message.role === "assistant"), retries, configDirs };
	} finally {
		session.dispose();
	}
}

describe("Claude bridge account rotation", () => {
	it("serves the same prompt on the next account when the SDK throws after the quota error result", async () => {
		const { agentDir, profileDir } = setUpProfiles();

		const { reply, retries, configDirs } = await promptBridge(agentDir, (attempt) =>
			attempt === 1 ? quotaRejectedQuery() : servedQuery(),
		);

		expect(reply).toMatchObject({ stopReason: "stop" });
		expect(reply?.content).toContainEqual({ type: "text", text: "Served on the next account." });
		expect(retries).toEqual([]);
		expect(configDirs.slice(0, 2)).toEqual([profileDir("alpha"), profileDir("beta")]);
	});

	it("serves the prompt on the next account when the selected account's login was cleared", async () => {
		const { agentDir, profileDir } = setUpProfiles();
		// Claude Code empties the profile's own credential file when a token refresh fails.
		mkdirSync(profileDir("alpha"), { recursive: true });
		writeFileSync(join(profileDir("alpha"), ".credential-owner"), "shared-v1\n");
		writeFileSync(
			join(profileDir("alpha"), ".credentials.json"),
			JSON.stringify({ claudeAiOauth: { accessToken: "", refreshToken: "" } }),
		);

		const { reply, retries, configDirs } = await promptBridge(agentDir, () => servedQuery());

		expect(reply).toMatchObject({ stopReason: "stop" });
		expect(reply?.content).toContainEqual({ type: "text", text: "Served on the next account." });
		expect(retries).toEqual([]);
		expect(configDirs[0]).toBe(profileDir("beta"));
	});
	it("summarizes /compact on the next account when the SDK throws after the quota error result", async () => {
		const { profileDir } = setUpProfiles();
		const configDirs: string[] = [];
		__test.setIsolatedQuery((({ options }: { options: { env: Record<string, string> } }) => {
			configDirs.push(options.env.CLAUDE_CONFIG_DIR);
			const messages =
				configDirs.length === 1
					? quotaRejectedQuery()
					: (async function* () {
							yield { type: "result", subtype: "success", is_error: false, result: "summary from beta" };
						})();
			return Object.assign(messages, { interrupt: async () => {}, close: () => {} });
		}) as never);
		const handlers = new Map<string, (...args: unknown[]) => unknown>();
		bridge({
			cwd: root,
			events: { on() {}, emit() {} },
			on: (event: string, handler: (...args: unknown[]) => unknown) => handlers.set(event, handler),
			registerProvider() {},
			registerTool() {},
		} as never);
		const model = {
			id: "claude-sonnet-4-5",
			name: "Claude Sonnet 4.5",
			api: "anthropic-messages",
			provider: "claude-bridge",
			baseUrl: "claude-bridge",
			reasoning: true,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 200_000,
			maxTokens: 64_000,
		};
		const preparation = {
			firstKeptEntryId: "kept",
			messagesToSummarize: [{ role: "user", content: "old request", timestamp: 1 }],
			turnPrefixMessages: [],
			isSplitTurn: false,
			tokensBefore: 1000,
			fileOps: { read: new Set(), written: new Set(), edited: new Set(), modified: new Set() },
			settings: { enabled: true, reserveTokens: 1000, keepRecentMessages: 1 },
		};
		const event = {
			type: "compaction",
			preparation,
			branchEntries: [],
			reason: "manual",
			willRetry: false,
			signal: new AbortController().signal,
		};

		const result = (await handlers.get("compaction")?.(event, { cwd: root, model, ui: {} })) as
			| { cancel?: boolean; compaction?: { summary: string } }
			| undefined;

		expect(result?.cancel).toBeUndefined();
		expect(result?.compaction?.summary).toContain("summary from beta");
		expect(configDirs).toEqual([profileDir("alpha"), profileDir("beta")]);
	});
});
