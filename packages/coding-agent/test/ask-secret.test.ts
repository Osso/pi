import { access, chmod, mkdir, mkdtemp, readdir, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { type AskSecretProvisioner, createAskSecretToolDefinition } from "../extensions/ask-secret/src/index.ts";
import type { ExtensionContext } from "../src/core/extensions/types.ts";

const temporaryDirectories: string[] = [];

type InputFunction = NonNullable<ExtensionContext["ui"]["input"]>;

async function createTemporaryDirectory(): Promise<string> {
	const directory = await mkdtemp(join(tmpdir(), "pi-ask-secret-"));
	temporaryDirectories.push(directory);
	return directory;
}

function createTuiContext(input: InputFunction): ExtensionContext {
	return {
		mode: "tui",
		hasUI: true,
		ui: { input },
	} as unknown as ExtensionContext;
}

afterEach(async () => {
	const directories = temporaryDirectories.splice(0);
	await Promise.all(directories.map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("ask_secret extension", () => {
	it("preserves browser provisioning and returns only non-secret metadata", async () => {
		const provision = vi.fn<AskSecretProvisioner>().mockResolvedValue(undefined);
		const input = vi.fn<InputFunction>().mockResolvedValueOnce("rei-user").mockResolvedValueOnce("super-secret");
		const tool = createAskSecretToolDefinition({ provision });
		const context = createTuiContext(input);

		const result = await tool.execute(
			"call-1",
			{
				record: "browser/rei-capital-one.json",
				usernameSelector: "#usernameInputField",
				passwordSelector: "#pwInputField",
			},
			undefined,
			undefined,
			context,
		);

		expect(provision).toHaveBeenCalledWith(
			{
				record: "browser/rei-capital-one.json",
				usernameSelector: "#usernameInputField",
				passwordSelector: "#pwInputField",
			},
			"rei-user",
			"super-secret",
			undefined,
		);
		expect(input).toHaveBeenCalledTimes(2);
		expect(input).toHaveBeenNthCalledWith(1, "Secrets Broker username", "Enter username", { signal: undefined });
		expect(input).toHaveBeenNthCalledWith(2, "Secrets Broker password", "Enter password", {
			signal: undefined,
			secret: true,
		});
		expect(JSON.stringify(result)).not.toContain("rei-user");
		expect(JSON.stringify(result)).not.toContain("super-secret");
	});

	it("prompts once with masked input and returns only non-secret file metadata", async () => {
		const directory = await createTemporaryDirectory();
		const destination = join(directory, "openrouter.key");
		const secret = "openrouter-secret";
		const input = vi.fn<InputFunction>().mockResolvedValue(secret);
		const tool = createAskSecretToolDefinition();

		const result = await tool.execute(
			"call-file",
			{ path: destination, label: "OpenRouter API key" },
			undefined,
			undefined,
			createTuiContext(input),
		);

		expect(tool.approvalRequired).toBe(true);
		expect(input).toHaveBeenCalledTimes(1);
		expect(input).toHaveBeenCalledWith("OpenRouter API key", "Enter secret", {
			signal: undefined,
			secret: true,
		});
		expect(result.details).toEqual({ path: destination, status: "provisioned" });
		expect(JSON.stringify(result)).not.toContain(secret);
	});

	it("returns cancelled metadata without writing when single-value input is cancelled", async () => {
		const directory = await createTemporaryDirectory();
		const destination = join(directory, "cancelled.key");
		const input = vi.fn<InputFunction>().mockResolvedValue(undefined);
		const tool = createAskSecretToolDefinition();

		const result = await tool.execute(
			"call-cancelled",
			{ path: destination, label: "OpenRouter API key" },
			undefined,
			undefined,
			createTuiContext(input),
		);

		expect(result).toEqual({
			content: [{ type: "text", text: "Secret provisioning cancelled." }],
			details: { status: "cancelled" },
		});
		await expect(access(destination)).rejects.toMatchObject({ code: "ENOENT" });
	});

	it("rejects invalid single-value requests before prompting", async () => {
		const directory = await createTemporaryDirectory();
		const input = vi.fn<InputFunction>();
		const tool = createAskSecretToolDefinition();
		const context = createTuiContext(input);

		await expect(
			tool.execute(
				"call-relative",
				{ path: "relative/openrouter.key", label: "OpenRouter API key" },
				undefined,
				undefined,
				context,
			),
		).rejects.toThrow("path must be absolute");
		await expect(
			tool.execute(
				"call-label-control",
				{ path: join(directory, "openrouter.key"), label: "OpenRouter\tAPI key" },
				undefined,
				undefined,
				context,
			),
		).rejects.toThrow("label must not contain control characters");
		expect(input).not.toHaveBeenCalled();
	});

	it("writes the exact secret with a trailing newline using owner-only permissions", async () => {
		const directory = await createTemporaryDirectory();
		const parentDirectory = join(directory, "missing", "provider");
		const destination = join(parentDirectory, "openrouter.key");
		const secret = "sk-or-v1-test";
		const tool = createAskSecretToolDefinition();

		await tool.execute(
			"call-write",
			{ path: destination, label: "OpenRouter API key" },
			undefined,
			undefined,
			createTuiContext(vi.fn<InputFunction>().mockResolvedValue(secret)),
		);

		expect(await readFile(destination, "utf8")).toBe(`${secret}\n`);
		expect((await stat(destination)).mode & 0o777).toBe(0o600);
		expect((await stat(parentDirectory)).mode & 0o777).toBe(0o700);
		expect(await readdir(parentDirectory)).toEqual(["openrouter.key"]);
	});

	it("atomically overwrites an existing regular file", async () => {
		const directory = await createTemporaryDirectory();
		const destination = join(directory, "openrouter.key");
		await writeFile(destination, "old-secret\n", { mode: 0o644 });
		await chmod(destination, 0o644);
		const tool = createAskSecretToolDefinition();

		await tool.execute(
			"call-overwrite",
			{ path: destination, label: "OpenRouter API key" },
			undefined,
			undefined,
			createTuiContext(vi.fn<InputFunction>().mockResolvedValue("new-secret")),
		);

		expect(await readFile(destination, "utf8")).toBe("new-secret\n");
		expect((await stat(destination)).mode & 0o777).toBe(0o600);
		expect(await readdir(directory)).toEqual(["openrouter.key"]);
	});

	it("preserves the destination and removes the temporary file when atomic rename fails", async () => {
		const directory = await createTemporaryDirectory();
		const destination = join(directory, "openrouter.key");
		const existingSecret = "existing-secret\n";
		const canarySecret = "rename-failure-canary";
		await writeFile(destination, existingSecret, { mode: 0o600 });
		let temporaryPath: string | undefined;
		const renameError = new Error("injected rename failure");
		const renameFile = vi.fn(async (source: string, target: string) => {
			temporaryPath = source;
			expect(target).toBe(destination);
			expect(await readFile(source, "utf8")).toBe(`${canarySecret}\n`);
			throw renameError;
		});
		const tool = createAskSecretToolDefinition({ renameFile });

		let thrown: unknown;
		try {
			await tool.execute(
				"call-rename-failure",
				{ path: destination, label: "OpenRouter API key" },
				undefined,
				undefined,
				createTuiContext(vi.fn<InputFunction>().mockResolvedValue(canarySecret)),
			);
		} catch (error) {
			thrown = error;
		}

		expect(thrown).toBe(renameError);
		expect(String(thrown)).not.toContain(canarySecret);
		expect(JSON.stringify(thrown)).not.toContain(canarySecret);
		expect(await readFile(destination, "utf8")).toBe(existingSecret);
		expect(temporaryPath).toBeDefined();
		await expect(access(temporaryPath as string)).rejects.toMatchObject({ code: "ENOENT" });
		expect(await readdir(directory)).toEqual(["openrouter.key"]);
	});

	it("rejects a symlink destination before prompting", async () => {
		const directory = await createTemporaryDirectory();
		const target = join(directory, "target.key");
		const destination = join(directory, "openrouter.key");
		await writeFile(target, "target-secret\n", { mode: 0o600 });
		await symlink(target, destination);
		const input = vi.fn<InputFunction>().mockResolvedValue("replacement-secret");
		const tool = createAskSecretToolDefinition();

		await expect(
			tool.execute(
				"call-symlink",
				{ path: destination, label: "OpenRouter API key" },
				undefined,
				undefined,
				createTuiContext(input),
			),
		).rejects.toThrow("path must not reference a symbolic link");
		expect(input).not.toHaveBeenCalled();
		expect(await readFile(target, "utf8")).toBe("target-secret\n");
	});

	it("rejects a non-regular destination before prompting", async () => {
		const directory = await createTemporaryDirectory();
		const destination = join(directory, "openrouter.key");
		await mkdir(destination);
		const input = vi.fn<InputFunction>();
		const tool = createAskSecretToolDefinition();

		await expect(
			tool.execute(
				"call-directory",
				{ path: destination, label: "OpenRouter API key" },
				undefined,
				undefined,
				createTuiContext(input),
			),
		).rejects.toThrow("path must reference a regular file or not exist");
		expect(input).not.toHaveBeenCalled();
	});

	it("fails closed outside an interactive TUI", async () => {
		const provision = vi.fn<AskSecretProvisioner>();
		const tool = createAskSecretToolDefinition({ provision });
		const result = await tool.execute(
			"call-2",
			{
				record: "browser/rei-capital-one.json",
				usernameSelector: "#usernameInputField",
				passwordSelector: "#pwInputField",
			},
			undefined,
			undefined,
			{ mode: "rpc", hasUI: false } as unknown as ExtensionContext,
		);

		expect(result.content).toEqual([{ type: "text", text: "Error: ask_secret requires an interactive TUI session" }]);
		expect(provision).not.toHaveBeenCalled();
	});

	it("fails closed for single-value requests outside an interactive TUI", async () => {
		const directory = await createTemporaryDirectory();
		const destination = join(directory, "openrouter.key");
		const tool = createAskSecretToolDefinition();

		const result = await tool.execute(
			"call-file-rpc",
			{ path: destination, label: "OpenRouter API key" },
			undefined,
			undefined,
			{ mode: "rpc", hasUI: false } as unknown as ExtensionContext,
		);

		expect(result.content).toEqual([{ type: "text", text: "Error: ask_secret requires an interactive TUI session" }]);
		await expect(access(destination)).rejects.toMatchObject({ code: "ENOENT" });
	});

	it("rejects unsafe broker arguments before prompting", async () => {
		const input = vi.fn<InputFunction>();
		const tool = createAskSecretToolDefinition({ provision: vi.fn<AskSecretProvisioner>() });
		const context = createTuiContext(input);

		await expect(
			tool.execute(
				"call-3",
				{
					record: "browser/rei-capital-one.json\nleak",
					usernameSelector: "#usernameInputField",
					passwordSelector: "#pwInputField",
				},
				undefined,
				undefined,
				context,
			),
		).rejects.toThrow("record must not contain control characters");
		expect(input).not.toHaveBeenCalled();
	});
});
