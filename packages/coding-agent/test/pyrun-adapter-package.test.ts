import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

interface PyrunPackageJson {
	bin?: Record<string, string>;
	dependencies?: Record<string, string>;
	description?: string;
}

function readPyrunPackageJson(): PyrunPackageJson {
	return JSON.parse(readFileSync(join(process.cwd(), "extensions/pyrun/package.json"), "utf8")) as PyrunPackageJson;
}

function readPyrunReadme(): string {
	return readFileSync(join(process.cwd(), "extensions/pyrun/README.md"), "utf8");
}

describe("Pyrun adapter package", () => {
	it("does not publish a duplicate pyrun-mcp binary from Pi", () => {
		const packageJson = readPyrunPackageJson();

		expect(packageJson.description).toContain("adapter");
		expect(packageJson.bin?.["pyrun-mcp"]).toBeUndefined();
	});

	it("does not depend on the Python Pyrun runtime implementation package", () => {
		const packageJson = readPyrunPackageJson();

		expect(packageJson.dependencies?.pyrun).toBeUndefined();
		expect(packageJson.dependencies?.["@earendil-works/pyrun"]).toBeUndefined();
	});

	it("documents that Pyrun runtime and MCP ownership stay in the Pyrun repository", () => {
		const readme = readPyrunReadme();

		expect(readme).toContain("/syncthing/Sync/Projects/claude/pyrun");
		expect(readme).toContain("Pi adapter");
		expect(readme).toContain("does not implement the Pyrun runtime");
		expect(readme).toContain("pyrun-mcp is owned by Pyrun");
	});
});
