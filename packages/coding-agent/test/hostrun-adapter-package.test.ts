import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

interface HostrunPackageJson {
	bin?: Record<string, string>;
	dependencies?: Record<string, string>;
	description?: string;
}

function readHostrunPackageJson(): HostrunPackageJson {
	return JSON.parse(
		readFileSync(join(process.cwd(), "extensions/hostrun/package.json"), "utf8"),
	) as HostrunPackageJson;
}

function readHostrunReadme(): string {
	return readFileSync(join(process.cwd(), "extensions/hostrun/README.md"), "utf8");
}

describe("Hostrun adapter package", () => {
	it("does not publish a duplicate hostrun-mcp binary from Pi", () => {
		const packageJson = readHostrunPackageJson();

		expect(packageJson.description).toContain("adapter");
		expect(packageJson.bin?.["hostrun-mcp"]).toBeUndefined();
	});

	it("does not depend on a Pi-local QuickJS runtime", () => {
		const packageJson = readHostrunPackageJson();

		expect(packageJson.dependencies?.["quickjs-emscripten"]).toBeUndefined();
	});

	it("documents that Hostrun runtime and MCP ownership stay in the Hostrun repository", () => {
		const readme = readHostrunReadme();

		expect(readme).toContain("/home/osso/Repos/hostrun");
		expect(readme).toContain("Pi adapter");
		expect(readme).toContain("does not implement the Hostrun runtime");
		expect(readme).toContain("hostrun-mcp is owned by Hostrun");
	});
});
