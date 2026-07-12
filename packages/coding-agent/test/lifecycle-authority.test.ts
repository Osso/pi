import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";

const packageRoot = join(import.meta.dirname, "..");
const productionRoots = [join(packageRoot, "src"), join(packageRoot, "extensions")];
const excludedFiles = new Set([
	"src/core/lifecycle-coordinator.ts",
	"src/core/multi-agent-store.ts",
	"src/core/session-control-db.ts",
]);
const forbiddenCalls = [
	".ackSteering(",
	".attachSessionAgent(",
	".sendSteering(",
	".spawnAgent(",
	".spawnChildAgent(",
	".transitionAgent(",
	"bootstrapMultiAgentAgent(",
];

describe("lifecycle authority", () => {
	it("does not expose direct lifecycle mutation methods on MultiAgentStore", () => {
		const source = readFileSync(join(packageRoot, "src/core/multi-agent-store.ts"), "utf8");
		expect(source).not.toContain("\n\ttransitionAgent(");
		expect(source).not.toContain("\n\tsendSteering(");
		expect(source).not.toContain("\n\tackSteering(");
	});

	it("contains no production direct lifecycle writers outside authority modules", () => {
		const violations: string[] = [];
		for (const file of productionRoots.flatMap(listTypeScriptFiles)) {
			const relativePath = relative(packageRoot, file);
			if (excludedFiles.has(relativePath)) continue;
			const source = readFileSync(file, "utf8");
			for (const call of forbiddenCalls) {
				if (source.includes(call)) violations.push(`${relativePath}: ${call}`);
			}
		}
		expect(violations).toEqual([]);
	});
});

function listTypeScriptFiles(directory: string): string[] {
	const files: string[] = [];
	for (const entry of readdirSync(directory, { withFileTypes: true })) {
		const path = join(directory, entry.name);
		if (entry.isDirectory()) {
			files.push(...listTypeScriptFiles(path));
		} else if (entry.isFile() && entry.name.endsWith(".ts")) {
			files.push(path);
		}
	}
	return files;
}
