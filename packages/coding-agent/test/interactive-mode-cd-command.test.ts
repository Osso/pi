import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { InteractiveMode } from "../src/modes/interactive/interactive-mode.ts";

type CdCommandContext = {
	sessionManager: { getCwd: () => string };
	runtimeHost: { relocate: (cwd: string, options?: { projectTrustContext?: unknown }) => Promise<void> };
	createProjectTrustContext: (cwd: string) => unknown;
	renderCurrentSessionState: () => void;
	showStatus: (message: string) => void;
	showError: (message: string) => void;
};

type InteractiveModePrototype = {
	handleCdCommand(this: CdCommandContext, text: string): Promise<void>;
	getDirectoryCompletions(
		this: { sessionManager: { getCwd: () => string } },
		prefix: string,
	): Array<{
		value: string;
		label: string;
	}>;
};

const interactiveModePrototype = InteractiveMode.prototype as unknown as InteractiveModePrototype;

describe("InteractiveMode /cd", () => {
	let tempDir: string;
	let targetDir: string;

	beforeEach(() => {
		tempDir = join(tmpdir(), `pi-cd-command-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		targetDir = join(tempDir, "target dir");
		mkdirSync(targetDir, { recursive: true });
	});

	afterEach(() => {
		rmSync(tempDir, { recursive: true, force: true });
	});

	function createContext(cwd: string = tempDir): CdCommandContext {
		return {
			sessionManager: { getCwd: () => cwd },
			runtimeHost: { relocate: vi.fn(async () => {}) },
			createProjectTrustContext: vi.fn((projectCwd) => ({ cwd: projectCwd })),
			renderCurrentSessionState: vi.fn(),
			showStatus: vi.fn(),
			showError: vi.fn(),
		};
	}

	it("relocates to a quoted directory path", async () => {
		const context = createContext(targetDir);

		await interactiveModePrototype.handleCdCommand.call(context, `/cd "${targetDir}"`);

		expect(context.runtimeHost.relocate).toHaveBeenCalledWith(targetDir, { projectTrustContext: { cwd: targetDir } });
		expect(context.renderCurrentSessionState).toHaveBeenCalled();
		expect(context.showStatus).toHaveBeenCalledWith(`Changed working directory to ${targetDir}`);
		expect(context.showError).not.toHaveBeenCalled();
	});

	it("rejects missing or ambiguous paths", async () => {
		const context = createContext();

		await interactiveModePrototype.handleCdCommand.call(context, "/cd");
		await interactiveModePrototype.handleCdCommand.call(context, "/cd one two");

		expect(context.runtimeHost.relocate).not.toHaveBeenCalled();
		expect(context.showError).toHaveBeenCalledTimes(2);
		expect(context.showError).toHaveBeenCalledWith("Usage: /cd <path>");
	});

	function createCompletionContext(cwd: string = tempDir): { sessionManager: { getCwd: () => string } } {
		const completionContext = Object.create(InteractiveMode.prototype) as {
			sessionManager: { getCwd: () => string };
		};
		Object.defineProperty(completionContext, "sessionManager", { value: { getCwd: () => cwd } });
		return completionContext;
	}

	it("completes directories only", () => {
		mkdirSync(join(tempDir, "alpha"));
		mkdirSync(join(tempDir, "beta"));
		writeFileSync(join(tempDir, "afile"), "not a directory");

		const completions = interactiveModePrototype.getDirectoryCompletions.call(createCompletionContext(), "a");

		expect(completions).toEqual([{ value: "alpha/", label: "alpha/" }]);
	});

	it("completes home and parent directory roots", () => {
		expect(interactiveModePrototype.getDirectoryCompletions.call(createCompletionContext(), "~")).toEqual([
			{ value: "~/", label: "~/" },
		]);
		expect(interactiveModePrototype.getDirectoryCompletions.call(createCompletionContext(), "..")).toEqual([
			{ value: "../", label: "../" },
		]);
	});

	it("balances quotes for directory paths containing spaces", () => {
		const completions = interactiveModePrototype.getDirectoryCompletions.call(createCompletionContext(), "target");

		expect(completions).toEqual([{ value: '"target dir/"', label: "target dir/" }]);
	});

	it("continues quoted directory completions without doubled separators", () => {
		mkdirSync(join(targetDir, "child"));

		const completions = interactiveModePrototype.getDirectoryCompletions.call(
			createCompletionContext(),
			'"target dir/',
		);

		expect(completions).toEqual([{ value: '"target dir/child/"', label: "child/" }]);
	});

	it("continues parent directory completions without doubled separators", () => {
		const nestedCwd = join(tempDir, "nested");
		mkdirSync(nestedCwd);

		const completions = interactiveModePrototype.getDirectoryCompletions.call(
			createCompletionContext(nestedCwd),
			"../t",
		);

		expect(completions).toEqual([{ value: '"../target dir/"', label: "target dir/" }]);
	});
});
