import { Buffer } from "node:buffer";
import { randomUUID } from "node:crypto";
import { type FileHandle, lstat, mkdir, open, rename, rm } from "node:fs/promises";
import { basename, dirname, isAbsolute, join } from "node:path";
import { spawnProcess, waitForChildProcess } from "../../../src/utils/child-process.ts";
import type { AgentToolResult, ExtensionAPI, ExtensionContext, ToolDefinition } from "../../../src/core/extensions/types.ts";
import { Type, type Static } from "typebox";

const AUTH_SUDO_EXECUTABLE = "authsudo";
const SECRETS_BROKER_ADMIN = "/usr/bin/secrets-broker-admin";
const PROVISION_OPERATION = "provision-browser";
const OWNER_ONLY_DIRECTORY_MODE = 0o700;
const OWNER_ONLY_FILE_MODE = 0o600;
const TRAILING_NEWLINE = 0x0a;

const browserSecretSchema = Type.Object(
	{
		record: Type.String({ description: "Secrets Broker browser credential record path." }),
		usernameSelector: Type.String({ description: "CSS selector for the username field." }),
		passwordSelector: Type.String({ description: "CSS selector for the password field." }),
	},
	{ additionalProperties: false },
);

const fileSecretSchema = Type.Object(
	{
		path: Type.String({ description: "Absolute destination path for the secret file." }),
		label: Type.String({ description: "Non-empty user-facing label for the masked secret prompt." }),
	},
	{ additionalProperties: false },
);

const askSecretSchema = Type.Union([browserSecretSchema, fileSecretSchema]);

type AskSecretInput = Static<typeof askSecretSchema>;
type BrowserSecretInput = Static<typeof browserSecretSchema>;
type FileSecretInput = Static<typeof fileSecretSchema>;

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

export type AskSecretRenameFile = (source: string, destination: string) => Promise<void>;

export interface AskSecretToolOptions {
	provision?: AskSecretProvisioner;
	renameFile?: AskSecretRenameFile;
}

export interface AskSecretDetails {
	path?: string;
	record?: string;
	status: "provisioned" | "cancelled" | "unavailable";
}

export default function askSecretExtension(pi: ExtensionAPI): void {
	pi.registerTool(createAskSecretToolDefinition());
}

export function createAskSecretToolDefinition(options: AskSecretToolOptions = {}): ToolDefinition<typeof askSecretSchema> {
	const provision = options.provision ?? provisionBrowserCredential;
	const renameFile = options.renameFile ?? rename;
	return {
		name: "ask_secret",
		label: "Ask Secret",
		description:
			"Prompt for browser credentials or one file-backed secret without returning secret values to the model.",
		promptSnippet:
			"Prompt for browser credentials or a single file-backed secret through a hidden interactive prompt.",
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
			if (ctx.mode !== "tui" || !ctx.hasUI) return unavailableResult();
			if ("path" in params) return executeFileRequest(params, signal, ctx, renameFile);
			return executeBrowserRequest(params, signal, ctx, provision);
		},
	};
}

async function executeBrowserRequest(
	params: BrowserSecretInput,
	signal: AbortSignal | undefined,
	ctx: ExtensionContext,
	provision: AskSecretProvisioner,
): Promise<AgentToolResult<AskSecretDetails>> {
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
		details: { record: params.record, status: "provisioned" },
	};
}

async function executeFileRequest(
	params: FileSecretInput,
	signal: AbortSignal | undefined,
	ctx: ExtensionContext,
	renameFile: AskSecretRenameFile,
): Promise<AgentToolResult<AskSecretDetails>> {
	await validateFileDestination(params.path);
	const secret = await ctx.ui.input(params.label, "Enter secret", { signal, secret: true });
	if (secret === undefined) return cancelledResult();
	try {
		await persistSecretFile(params.path, secret, renameFile, signal);
	} finally {
		clearStringReference(secret);
	}

	return {
		content: [{ type: "text", text: `Saved secret to ${params.path}.` }],
		details: { path: params.path, status: "provisioned" },
	};
}

function validateRequest(params: AskSecretInput): void {
	if ("path" in params) {
		validateArgument(params.path, "path");
		validateArgument(params.label, "label");
		if (!isAbsolute(params.path)) throw new Error("path must be absolute");
		return;
	}

	validateArgument(params.record, "record");
	validateArgument(params.usernameSelector, "usernameSelector");
	validateArgument(params.passwordSelector, "passwordSelector");
	if (params.record.startsWith("/") || params.record.split("/").includes("..")) {
		throw new Error("record must be a relative Secrets Broker path");
	}
}

function validateArgument(value: string, name: string): void {
	if (!value.trim()) throw new Error(`${name} must not be empty`);
	if (/\p{C}/u.test(value)) throw new Error(`${name} must not contain control characters`);
}

async function validateFileDestination(path: string): Promise<void> {
	try {
		const destination = await lstat(path);
		if (destination.isSymbolicLink()) throw new Error("path must not reference a symbolic link");
		if (!destination.isFile()) throw new Error("path must reference a regular file or not exist");
	} catch (error) {
		if (isErrorWithCode(error, "ENOENT")) return;
		throw error;
	}
}

async function persistSecretFile(
	path: string,
	secret: string,
	renameFile: AskSecretRenameFile,
	signal?: AbortSignal,
): Promise<void> {
	const payload = createSecretPayload(secret);
	try {
		await writeSecretPayloadAtomically(path, payload, renameFile, signal);
	} finally {
		payload.fill(0);
	}
}

function createSecretPayload(secret: string): Buffer {
	const secretBytes = Buffer.from(secret, "utf8");
	try {
		const payload = Buffer.alloc(secretBytes.length + 1);
		secretBytes.copy(payload);
		payload[payload.length - 1] = TRAILING_NEWLINE;
		return payload;
	} finally {
		secretBytes.fill(0);
	}
}

async function writeSecretPayloadAtomically(
	path: string,
	payload: Buffer,
	renameFile: AskSecretRenameFile,
	signal?: AbortSignal,
): Promise<void> {
	throwIfAborted(signal);
	const parentDirectory = dirname(path);
	await mkdir(parentDirectory, { recursive: true, mode: OWNER_ONLY_DIRECTORY_MODE });
	await validateFileDestination(path);

	const temporaryPath = join(parentDirectory, `.${basename(path)}.${randomUUID()}.tmp`);
	let temporaryFile: FileHandle | undefined;
	let writeError: unknown;
	try {
		temporaryFile = await open(temporaryPath, "wx", OWNER_ONLY_FILE_MODE);
		await temporaryFile.chmod(OWNER_ONLY_FILE_MODE);
		await temporaryFile.writeFile(payload);
		await temporaryFile.sync();
		await temporaryFile.close();
		temporaryFile = undefined;
		throwIfAborted(signal);
		await validateFileDestination(path);
		await renameFile(temporaryPath, path);
	} catch (error) {
		writeError = error;
	}

	const cleanupError = await cleanupTemporaryFile(temporaryFile, temporaryPath);
	throwFileOperationErrors(writeError, cleanupError);
}

async function cleanupTemporaryFile(temporaryFile: FileHandle | undefined, temporaryPath: string): Promise<unknown> {
	const cleanupErrors: unknown[] = [];
	if (temporaryFile) {
		try {
			await temporaryFile.close();
		} catch (error) {
			cleanupErrors.push(error);
		}
	}
	try {
		await rm(temporaryPath, { force: true });
	} catch (error) {
		cleanupErrors.push(error);
	}
	if (cleanupErrors.length === 0) return undefined;
	if (cleanupErrors.length === 1) return cleanupErrors[0];
	return new AggregateError(cleanupErrors, "Secret temporary file cleanup failed");
}

function throwFileOperationErrors(writeError: unknown, cleanupError: unknown): void {
	if (writeError && cleanupError) {
		throw new AggregateError([writeError, cleanupError], "Secret file write and cleanup failed");
	}
	if (writeError) throw writeError;
	if (cleanupError) throw cleanupError;
}

function throwIfAborted(signal?: AbortSignal): void {
	if (signal?.aborted) throw new Error("ask_secret cancelled");
}

function isErrorWithCode(error: unknown, code: string): boolean {
	return error instanceof Error && "code" in error && error.code === code;
}

function unavailableResult(): AgentToolResult<AskSecretDetails> {
	return {
		content: [{ type: "text", text: "Error: ask_secret requires an interactive TUI session" }],
		details: { status: "unavailable" },
	};
}

function cancelledResult(): AgentToolResult<AskSecretDetails> {
	return {
		content: [{ type: "text", text: "Secret provisioning cancelled." }],
		details: { status: "cancelled" },
	};
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
