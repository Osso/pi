import { createInterface } from "node:readline/promises";
import type { Readable, Writable } from "node:stream";
import { getOAuthProvider, getOAuthProviders } from "@earendil-works/pi-ai/oauth";
import chalk from "chalk";
import { AuthStorage } from "../core/auth-storage.ts";

export interface LoginCommandDependencies {
	authStorage?: AuthStorage;
	input?: Readable;
	output?: Writable;
	error?: Writable;
}

export interface RunLoginCommandOptions {
	authStorage: AuthStorage;
	providerId: string;
	input?: Readable;
	output?: Writable;
	error?: Writable;
}

interface PromptReader {
	prompt(message: string): Promise<string>;
	close(): void;
}

function writeLine(stream: Writable, message = ""): void {
	stream.write(`${message}\n`);
}

function formatProviderList(): string {
	return getOAuthProviders()
		.map((provider) => `  ${provider.id.padEnd(20)} ${provider.name}`)
		.join("\n");
}

function printLoginUsage(error: Writable): void {
	writeLine(error, "Usage: pi login <provider>");
	writeLine(error, `Available OAuth providers:\n${formatProviderList()}`);
}

function collectInputLines(input: Readable): Promise<string[]> {
	input.setEncoding("utf8");
	return new Promise((resolve, reject) => {
		let text = "";
		input.on("data", (chunk: string) => {
			text += chunk;
		});
		input.on("end", () => resolve(text.split(/\r?\n/)));
		input.on("error", reject);
	});
}

function createPromptReader(input: Readable, output: Writable): PromptReader {
	if (input !== process.stdin || !process.stdin.isTTY) {
		const linesPromise = collectInputLines(input);
		let nextLineIndex = 0;
		return {
			async prompt(message: string) {
				output.write(message);
				const lines = await linesPromise;
				const line = lines[nextLineIndex] ?? "";
				nextLineIndex += 1;
				return line;
			},
			close() {},
		};
	}

	const rl = createInterface({ input, output });
	return {
		prompt: (message) => rl.question(message),
		close: () => rl.close(),
	};
}

async function selectOption(
	message: string,
	options: { id: string; label: string }[],
	prompt: (message: string) => Promise<string>,
	stdout: (message: string) => void,
): Promise<string | undefined> {
	stdout(message);
	for (const [index, option] of options.entries()) {
		stdout(`  ${index + 1}. ${option.label} (${option.id})`);
	}

	const defaultOptionId = options[0]?.id;
	const answer = (await prompt(`Enter number or id (default: ${defaultOptionId ?? "none"}): `)).trim();
	if (!answer) return defaultOptionId;

	const selectedIndex = Number.parseInt(answer, 10) - 1;
	const selectedByIndex = options[selectedIndex];
	if (selectedByIndex) return selectedByIndex.id;

	const selectedById = options.find((option) => option.id === answer);
	return selectedById?.id;
}

async function runLoginWithPrompt(
	authStorage: AuthStorage,
	providerId: string,
	prompt: (message: string) => Promise<string>,
	stdout: (message: string) => void,
): Promise<void> {
	await authStorage.login(providerId, {
		onAuth: (info) => {
			stdout("");
			stdout("Open this URL in your browser:");
			stdout(info.url);
			if (info.instructions) stdout(info.instructions);
			stdout("");
		},
		onDeviceCode: (info) => {
			stdout("");
			stdout("Open this URL in your browser:");
			stdout(info.verificationUri);
			stdout(`Enter code: ${info.userCode}`);
			if (info.expiresInSeconds !== undefined) stdout(`Code expires in ${info.expiresInSeconds} seconds.`);
			stdout("");
		},
		onPrompt: (oauthPrompt) =>
			prompt(`${oauthPrompt.message}${oauthPrompt.placeholder ? ` (${oauthPrompt.placeholder})` : ""}: `),
		onManualCodeInput: () => prompt("Paste authorization code or redirect URL: "),
		onProgress: (message) => stdout(message),
		onSelect: (oauthPrompt) => selectOption(oauthPrompt.message, oauthPrompt.options, prompt, stdout),
	});
}

export async function runLoginCommand(options: RunLoginCommandOptions): Promise<number> {
	const provider = getOAuthProvider(options.providerId);
	const error = options.error ?? process.stderr;
	const output = options.output ?? process.stdout;

	if (!provider) {
		writeLine(error, chalk.red(`Unknown OAuth provider: ${options.providerId}`));
		writeLine(error, `Available OAuth providers:\n${formatProviderList()}`);
		return 1;
	}

	const promptReader = createPromptReader(options.input ?? process.stdin, output);
	const stdout = (message: string) => writeLine(output, message);

	try {
		writeLine(output, `Logging in to ${provider.name} (${options.providerId})...`);
		await runLoginWithPrompt(
			options.authStorage,
			options.providerId,
			(message) => promptReader.prompt(message),
			stdout,
		);
		writeLine(output, chalk.green(`Credentials saved for ${options.providerId}.`));
		return 0;
	} catch (caught) {
		const message = caught instanceof Error ? caught.message : String(caught);
		writeLine(error, chalk.red(`Failed to login to ${provider.name}: ${message}`));
		return 1;
	} finally {
		promptReader.close();
	}
}

export async function handleLoginCommand(
	args: string[],
	dependencies: LoginCommandDependencies = {},
): Promise<boolean> {
	if (args[0] !== "login") return false;

	const providerId = args[1];
	const error = dependencies.error ?? process.stderr;
	if (args.length !== 2 || !providerId || providerId === "--help" || providerId === "-h") {
		printLoginUsage(error);
		process.exitCode = providerId === "--help" || providerId === "-h" ? 0 : 1;
		return true;
	}

	process.exitCode = await runLoginCommand({
		authStorage: dependencies.authStorage ?? AuthStorage.create(),
		providerId,
		input: dependencies.input,
		output: dependencies.output,
		error,
	});
	return true;
}
