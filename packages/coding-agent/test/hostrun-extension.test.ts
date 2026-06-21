import { describe, expect, it } from "vitest";
import hostrunExtension from "../extensions/hostrun/src/index.ts";
import type { AgentToolResult, ExtensionAPI, ExtensionContext, ToolDefinition } from "../src/core/extensions/types.ts";

interface HostrunEvalParams {
	code: string;
	session_id?: string;
}

interface HostrunConsoleEntry {
	level: "debug" | "error" | "info" | "log" | "warn";
	text: string;
}

interface HostrunEvalDetails {
	code: string;
	sessionId: string;
	result: unknown;
	console: HostrunConsoleEntry[];
	error?: {
		name: string;
		message: string;
	};
}

type HostrunTool = {
	name: string;
	execute: (
		toolCallId: string,
		params: HostrunEvalParams,
		signal: AbortSignal | undefined,
		onUpdate: undefined,
		ctx: ExtensionContext,
	) => Promise<AgentToolResult<HostrunEvalDetails>>;
};

function createHostrunHarness() {
	let hostrunTool: HostrunTool | undefined;

	const pi = {
		registerTool(tool: ToolDefinition) {
			if (tool.name === "hostrun_eval") {
				hostrunTool = tool as unknown as HostrunTool;
			}
		},
	} as unknown as ExtensionAPI;

	hostrunExtension(pi);

	if (!hostrunTool) {
		throw new Error("hostrun_eval was not registered");
	}

	const registeredHostrunTool = hostrunTool;

	return {
		evaluate: (params: HostrunEvalParams) =>
			registeredHostrunTool.execute("hostrun-test-call", params, undefined, undefined, {} as ExtensionContext),
	};
}

describe("hostrun extension", () => {
	it("registers hostrun_eval with persistent ctx per session", async () => {
		const harness = createHostrunHarness();

		const first = await harness.evaluate({ code: "ctx.count = 41; ctx.count" });
		const second = await harness.evaluate({ code: "ctx.count += 1; ctx.count" });
		const named = await harness.evaluate({ code: "typeof ctx.count", session_id: "named" });

		expect(first.details).toMatchObject({ code: "ctx.count = 41; ctx.count", sessionId: "default", result: 41 });
		expect(second.details.result).toBe(42);
		expect(named.details).toMatchObject({ sessionId: "named", result: "undefined" });
	});

	it("keeps ctx alive after a JavaScript exception", async () => {
		const harness = createHostrunHarness();

		await harness.evaluate({ code: "ctx.survives = 'yes'; throw new Error('boom')" });
		const result = await harness.evaluate({ code: "ctx.survives" });

		expect(result.details.result).toBe("yes");
	});

	it("captures console output from evaluations", async () => {
		const harness = createHostrunHarness();

		const result = await harness.evaluate({
			code: "console.log('ready', { count: 2 }); console.warn('careful'); 'done'",
		});

		expect(result.details.console).toEqual([
			{ level: "log", text: "ready { count: 2 }" },
			{ level: "warn", text: "careful" },
		]);
		expect(result.details.result).toBe("done");
	});

	it("returns exception details without discarding ctx", async () => {
		const harness = createHostrunHarness();

		const failed = await harness.evaluate({
			code: "ctx.beforeThrow = 7; console.error('boom soon'); throw new TypeError('bad hostrun')",
		});
		const recovered = await harness.evaluate({ code: "ctx.beforeThrow" });

		expect(failed.details).toMatchObject({
			error: { name: "TypeError", message: "bad hostrun" },
			result: undefined,
			console: [{ level: "error", text: "boom soon" }],
		});
		expect(recovered.details.result).toBe(7);
	});
});
