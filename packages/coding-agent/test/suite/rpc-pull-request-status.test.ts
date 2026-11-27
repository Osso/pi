import { execFileSync } from "node:child_process";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { withHeadlessPi } from "./headless-pi.ts";

const PR_URL = "https://github.com/earendil-works/pi/pull/41208";

describe("RPC pull-request status", () => {
	it("publishes the session branch's pull request, which RPC clients link", async () => {
		const binDir = mkdtempSync(join(tmpdir(), "rpc-github-bin-"));
		try {
			const pullRequest = {
				number: 41208,
				url: PR_URL,
				state: "open",
				checks: { passed: 4, running: 1, failed: 0 },
			};
			writeFileSync(
				join(binDir, "github"),
				`#!/bin/sh\necho "$*" >> "${binDir}/argv"\necho '${JSON.stringify(pullRequest)}'\n`,
			);
			chmodSync(join(binDir, "github"), 0o755);
			const env = { PATH: `${binDir}${delimiter}${process.env.PATH}` };
			await withHeadlessPi(
				async (agent) => {
					// The branch is read when the session starts: make the workspace a repository, then restart.
					const git = (...args: string[]) => execFileSync("git", args, { cwd: agent.paths.workspaceDir });
					git("init", "-q", "-b", "feature/ship");
					await agent.restart();
					await vi.waitFor(
						async () => {
							const state = (await agent.send({ type: "get_state" })) as unknown as {
								data: { extensionStatuses?: Record<string, string> };
							};
							expect(state.data.extensionStatuses?.["pull-request"]).toBe(`${PR_URL} open ✓ 4 ○ 1 ✗ 0`);
						},
						{ timeout: 15_000, interval: 200 },
					);
				},
				{ env },
			);
		} finally {
			rmSync(binDir, { recursive: true, force: true });
		}
	});
});
