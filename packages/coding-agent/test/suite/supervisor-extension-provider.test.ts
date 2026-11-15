import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { AuthStorage } from "../../src/core/auth-storage.ts";
import { ModelRegistry } from "../../src/core/model-registry.ts";
import { DefaultResourceLoader } from "../../src/core/resource-loader.ts";
import { SettingsManager } from "../../src/core/settings-manager.ts";
import { createSupervisorInstructionEvaluator } from "../../src/supervisor/request-evaluation.ts";

const EXTENSION_PATH = join(import.meta.dirname, "fixtures", "supervisor-extension-provider.ts");
const UNRELATED_EXTENSION_PATH = join(import.meta.dirname, "fixtures", "supervisor-extension-unrelated.ts");

interface ProviderReport {
	pid: number;
	provider: string;
	modelId: string;
	cwd: string;
	resident: boolean;
	oneOff: boolean;
	captured: boolean;
	tools: string[];
	unrelatedPromptMarker: boolean;
}

let tempDir: string;
let agentDir: string;
let kbDir: string;
let reportPath: string;

function readReports(): ProviderReport[] {
	return readFileSync(reportPath, "utf8")
		.trim()
		.split("\n")
		.map((line) => JSON.parse(line) as ProviderReport);
}

beforeEach(() => {
	tempDir = mkdtempSync(join(tmpdir(), "pi-supervisor-extension-provider-"));
	agentDir = join(tempDir, "agent");
	kbDir = join(tempDir, "kb");
	for (const dir of [agentDir, kbDir]) mkdirSync(dir);
	reportPath = join(tempDir, "requests.jsonl");
	// No auth.json or models.json: only a configured extension defines bridge-faux.
	writeFileSync(
		join(agentDir, "settings.json"),
		JSON.stringify({
			extensions: [UNRELATED_EXTENSION_PATH, EXTENSION_PATH],
			supervisorModel: "bridge-faux/haiku",
		}),
	);
});

afterEach(() => {
	rmSync(tempDir, { recursive: true, force: true });
});

it("instruction review uses a supervisorModel provider registered by an installed extension as a one-off call", async () => {
	vi.stubEnv("PI_SUPERVISOR_EXTENSION_REPORT", reportPath);
	try {
		// The Supervisor session's registry carries providers its installed extensions register.
		const modelRegistry = ModelRegistry.create(
			AuthStorage.create(join(agentDir, "auth.json")),
			join(agentDir, "models.json"),
		);
		const resourceLoader = new DefaultResourceLoader({
			agentDir,
			cwd: kbDir,
			settingsManager: SettingsManager.create(kbDir, agentDir),
		});
		await resourceLoader.reload();
		for (const { name, config } of resourceLoader.getExtensions().runtime.pendingProviderRegistrations) {
			modelRegistry.registerProvider(name, config);
		}
		const evaluate = createSupervisorInstructionEvaluator(modelRegistry, agentDir, kbDir);

		expect(await evaluate("Continue the goal", new AbortController().signal)).toBe("ACCEPT");
		expect(readReports()).toEqual([
			{
				pid: process.pid,
				provider: "bridge-faux",
				modelId: "haiku",
				cwd: kbDir,
				resident: false,
				oneOff: true,
				captured: true,
				tools: [],
				unrelatedPromptMarker: false,
			},
		]);
	} finally {
		vi.unstubAllEnvs();
	}
});
