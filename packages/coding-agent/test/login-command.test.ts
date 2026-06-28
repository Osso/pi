import { PassThrough } from "node:stream";
import { registerOAuthProvider, unregisterOAuthProvider } from "@earendil-works/pi-ai/oauth";
import { afterEach, describe, expect, test } from "vitest";
import { runLoginCommand } from "../src/cli/login-command.ts";
import { AuthStorage } from "../src/core/auth-storage.ts";

function createTerminalInput(lines: string[]): PassThrough {
	const input = new PassThrough();
	input.end(`${lines.join("\n")}\n`);
	return input;
}

function createTerminalOutput(): { stream: PassThrough; text: () => string } {
	const stream = new PassThrough();
	let output = "";
	stream.on("data", (chunk: Buffer) => {
		output += chunk.toString("utf-8");
	});
	return { stream, text: () => output };
}

describe("runLoginCommand", () => {
	const registeredProviders: string[] = [];

	afterEach(() => {
		for (const providerId of registeredProviders.splice(0)) {
			unregisterOAuthProvider(providerId);
		}
	});

	test("runs OAuth login callbacks from terminal IO and persists credentials under the requested provider", async () => {
		const providerId = `test-cli-login-${Date.now()}-${Math.random().toString(36).slice(2)}`;
		registeredProviders.push(providerId);

		registerOAuthProvider({
			id: providerId,
			name: "Test CLI Login",
			usesCallbackServer: true,
			async login(callbacks) {
				callbacks.onAuth({ url: "https://example.invalid/login", instructions: "Open browser" });
				callbacks.onDeviceCode({ verificationUri: "https://example.invalid/device", userCode: "ABCD-EFGH" });
				callbacks.onProgress?.("Waiting for login");
				const typedValue = await callbacks.onPrompt({ message: "Enter token", placeholder: "token" });
				const manualCode = await callbacks.onManualCodeInput?.();
				const selected = await callbacks.onSelect({
					message: "Select account:",
					options: [
						{ id: "first", label: "First Account" },
						{ id: "second", label: "Second Account" },
					],
				});
				return {
					access: `${typedValue}:${manualCode}:${selected}`,
					refresh: "refresh-token",
					expires: Date.now() + 60_000,
				};
			},
			async refreshToken(credentials) {
				return credentials;
			},
			getApiKey(credentials) {
				return credentials.access;
			},
		});

		const output = createTerminalOutput();
		const authStorage = AuthStorage.inMemory();
		const exitCode = await runLoginCommand({
			authStorage,
			providerId,
			input: createTerminalInput(["typed-token", "manual-code", "2"]),
			output: output.stream,
			error: output.stream,
		});

		expect(exitCode).toBe(0);
		expect(output.text()).toContain("https://example.invalid/login");
		expect(output.text()).toContain("ABCD-EFGH");
		expect(output.text()).toContain("Waiting for login");
		expect(output.text()).toContain(`Credentials saved for ${providerId}`);
		expect(authStorage.get(providerId)).toMatchObject({
			type: "oauth",
			access: "typed-token:manual-code:second",
			refresh: "refresh-token",
		});
	});

	test("returns nonzero and prints provider list guidance for unknown providers", async () => {
		const output = createTerminalOutput();
		const authStorage = AuthStorage.inMemory();
		const exitCode = await runLoginCommand({
			authStorage,
			providerId: "missing-provider",
			input: createTerminalInput([]),
			output: output.stream,
			error: output.stream,
		});

		expect(exitCode).toBe(1);
		expect(output.text()).toContain("Unknown OAuth provider: missing-provider");
		expect(output.text()).toContain("Available OAuth providers:");
		expect(authStorage.has("missing-provider")).toBe(false);
	});
});
