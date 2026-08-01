import { Buffer } from "node:buffer";
import { spawnProcess, waitForChildProcess } from "../../../src/utils/child-process.ts";
import type { AgentToolResult, ExtensionAPI, ExtensionContext, ToolDefinition } from "../../../src/core/extensions/types.ts";
import { Type, type Static } from "typebox";

const AUTH_SUDO_EXECUTABLE = "authsudo";
const SECRETS_BROKER_ADMIN = "/usr/bin/secrets-broker-admin";
const PROVISION_OPERATION = "provision-browser";

const askSecretSchema = Type.Object({
	record: Type.String({ description: "Secrets Broker browser credential record path." }),
	usernameSelector: Type.String({ description: "CSS selector for the username field." }),
	passwordSelector: Type.String({ description: "CSS selector for the password field." }),
});

type AskSecretInput = Static<typeof askSecretSchema>;

export interface AskSecretProvisionRequest {
	record: string;
	usernameSelector: string;
	passwordSelector: string;
}

export type AskSecretProvisioner = (
	request: AskSecretProvisionRequest,
	username: string,
	password: string,
	signal?: AbortSignal,
) => Promise<void>;

export interface AskSecretToolOptions {
	provision?: AskSecretProvisioner;
}

export interface AskSecretDetails {
	record: string;
	provisioned: true;
}

export default function askSecretExtension(pi: ExtensionAPI): void {
	pi.registerTool(createAskSecretToolDefinition());
}

export function createAskSecretToolDefinition(options: AskSecretToolOptions = {}): ToolDefinition<typeof askSecretSchema> {
	const provision = options.provision ?? provisionBrowserCredential;
	return {
		name: "ask_secret",
		label: "Ask Secret",
		description: "Prompt for browser credentials and provision them directly into the Secrets Broker without returning secret values.",
		promptSnippet: "Provision browser credentials through a hidden interactive prompt and the typed Secrets Broker path.",
		parameters: askSecretSchema,
		approvalRequired: true,
		executionMode: "sequential",
		async execute(
			_toolCallId,
			params: AskSecretInput,
			signal,
			_onUpdate,
			ctx: ExtensionContext,
		): Promise<AgentToolResult<AskSecretDetails>> {
			validateRequest(params);
			if (ctx.mode !== "tui" || !ctx.hasUI) {
				return {
					content: [{ type: "text", text: "Error: ask_secret requires an interactive TUI session" }],
				};
			}

			const username = await ctx.ui.input("Secrets Broker username", "Enter username", { signal });
			if (username === undefined) return cancelledResult();
			const password = await ctx.ui.input("Secrets Broker password", "Enter password", { signal, secret: true });
			if (password === undefined) return cancelledResult();
			try {
				await provision(params, username, password, signal);
			} finally {
				clearStringReference(username);
				clearStringReference(password);
			}

			return {
				content: [{ type: "text", text: `Provisioned Secrets Broker record ${params.record}.` }],
				details: { record: params.record, provisioned: true },
			};
		},
	};
}

function validateRequest(params: AskSecretInput): void {
	validateArgument(params.record, "record");
	validateArgument(params.usernameSelector, "usernameSelector");
	validateArgument(params.passwordSelector, "passwordSelector");
	if (params.record.startsWith("/") || params.record.split("/").includes("..")) {
		throw new Error("record must be a relative Secrets Broker path");
	}
}

function validateArgument(value: string, name: string): void {
	if (!value.trim()) throw new Error(`${name} must not be empty`);
	if (/[^\P{C}\t]/u.test(value)) throw new Error(`${name} must not contain control characters`);
}

function cancelledResult(): AgentToolResult<AskSecretDetails> {
	return { content: [{ type: "text", text: "Secret provisioning cancelled." }] };
}

async function provisionBrowserCredential(
	request: AskSecretProvisionRequest,
	username: string,
	password: string,
	signal?: AbortSignal,
): Promise<void> {
	if (signal?.aborted) throw new Error("ask_secret cancelled");
	const child = spawnProcess(
		AUTH_SUDO_EXECUTABLE,
		[
			"-u",
			"secrets-broker",
			SECRETS_BROKER_ADMIN,
			PROVISION_OPERATION,
			"--record",
			request.record,
			"--username-selector",
			request.usernameSelector,
			"--password-selector",
			request.passwordSelector,
		],
		{ stdio: ["pipe", "ignore", "ignore"] },
	);
	const onAbort = () => {
		if (!child.killed) child.kill();
	};
	signal?.addEventListener("abort", onAbort, { once: true });
	try {
		await writeCredentialInput(child, username, password);
		const exitCode = await waitForChildProcess(child);
		if (signal?.aborted) throw new Error("ask_secret cancelled");
		if (exitCode !== 0) throw new Error("Secrets Broker provisioning failed");
	} catch (error) {
		if (signal?.aborted) throw new Error("ask_secret cancelled");
		if (error instanceof Error && error.message === "Secrets Broker provisioning failed") throw error;
		throw new Error("Secrets Broker provisioning failed");
	} finally {
		signal?.removeEventListener("abort", onAbort);
	}
}

async function writeCredentialInput(
	child: ReturnType<typeof spawnProcess>,
	username: string,
	password: string,
): Promise<void> {
	if (!child.stdin) throw new Error("Secrets Broker provisioning has no stdin");
	const payload = Buffer.from(`${username}\n${password}\n`, "utf8");
	try {
		await new Promise<void>((resolve, reject) => {
			child.stdin?.once("error", reject);
			child.stdin?.end(payload, resolve);
		});
	} finally {
		payload.fill(0);
	}
}

function clearStringReference(_value: string): void {
	// JavaScript strings are immutable; dropping the local reference is the only available cleanup.
}
