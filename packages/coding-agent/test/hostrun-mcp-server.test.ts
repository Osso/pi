import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createHostrunMcpServer } from "../extensions/hostrun/src/mcp-server.ts";

function listen(server: Server): Promise<number> {
	return new Promise((resolve) => {
		server.listen(0, "127.0.0.1", () => {
			resolve((server.address() as AddressInfo).port);
		});
	});
}

describe("Hostrun MCP server", () => {
	let tempDir: string;
	const servers: Server[] = [];

	beforeEach(() => {
		tempDir = mkdtempSync(join(tmpdir(), "pi-hostrun-mcp-"));
	});

	afterEach(async () => {
		rmSync(tempDir, { force: true, recursive: true });
		await Promise.all(
			servers.splice(0).map(
				(server) =>
					new Promise<void>((resolve, reject) => {
						server.close((error) => (error ? reject(error) : resolve()));
					}),
			),
		);
	});

	it("registers hostrun_eval for stdio MCP clients", () => {
		const server = createHostrunMcpServer();

		expect(server.transport).toBe("stdio");
		expect(server.tools).toEqual([
			{
				description: "Evaluate JavaScript in a persistent Hostrun session.",
				inputSchema: {
					properties: {
						code: { type: "string" },
						session_id: { type: "string" },
					},
					required: ["code"],
					type: "object",
				},
				name: "hostrun_eval",
			},
		]);
	});

	it("defaults CLI effects to pending approval and does not execute them", async () => {
		const server = createHostrunMcpServer();

		const result = await server.callTool("hostrun_eval", {
			code: "cli.node('-e', 'console.log(\"should-not-run\")').stdout.text()",
		});

		expect(result.details.error?.message).toContain("denied");
	});

	it("defaults filesystem effects to pending approval and does not execute them", async () => {
		const target = join(tempDir, "blocked.txt");
		const server = createHostrunMcpServer();

		const result = await server.callTool("hostrun_eval", {
			code: `fs.write(${JSON.stringify(target)}, 'blocked')`,
		});

		expect(result.details.error?.message).toContain("denied");
		expect(existsSync(target)).toBe(false);
	});

	it("defaults HTTP effects to pending approval and does not execute them", async () => {
		let requests = 0;
		const httpServer = createServer((_request, response) => {
			requests += 1;
			response.end("should-not-run");
		});
		servers.push(httpServer);
		const port = await listen(httpServer);
		const server = createHostrunMcpServer();

		const result = await server.callTool("hostrun_eval", {
			code: `http.get('http://127.0.0.1:${port}/blocked').text()`,
		});

		expect(result.details.error?.message).toContain("denied");
		expect(requests).toBe(0);
	});
});
