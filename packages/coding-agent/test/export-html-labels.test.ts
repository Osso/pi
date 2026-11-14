import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { describe, expect, it } from "vitest";

const templateJs = readFileSync(new URL("../src/core/export-html/template.js", import.meta.url), "utf-8");

/** A permissive DOM stand-in: every property is callable and chainable; innerHTML writes are recorded. */
function createRecordingDom(sessionDataBase64: string): { context: object; html: string[] } {
	const html: string[] = [];
	const node = (): object =>
		new Proxy(() => {}, {
			get: (_target, property) => {
				if (property === Symbol.toPrimitive) return () => "";
				if (property === "length") return 0;
				if (property === Symbol.iterator) return [][Symbol.iterator];
				if (property === "then") return undefined;
				return node();
			},
			set: (_target, property, value) => {
				if (property === "innerHTML" && typeof value === "string") html.push(value);
				return true;
			},
			apply: () => node(),
		});
	const document = new Proxy(
		{},
		{
			get: (_target, property) => {
				if (property === "getElementById") {
					return (id: string) => (id === "session-data" ? { textContent: sessionDataBase64 } : node());
				}
				if (property === "querySelector")
					return (selector: string) => (selector.startsWith("meta") ? null : node());
				return node();
			},
		},
	);
	const window = new Proxy({ location: { search: "", hash: "" } } as Record<string | symbol, unknown>, {
		get: (target, property) => (property in target ? target[property] : node()),
	});
	return {
		html,
		context: {
			document,
			window,
			atob: (value: string) => Buffer.from(value, "base64").toString("binary"),
			TextDecoder,
			URLSearchParams,
			Map,
			Set,
			JSON,
			console,
			setTimeout: () => 0,
			clearTimeout: () => {},
			requestAnimationFrame: () => 0,
			getComputedStyle: () => node(),
			matchMedia: () => node(),
			addEventListener: () => {},
			marked: node(),
			hljs: node(),
			localStorage: node(),
			navigator: node(),
			history: node(),
		},
	};
}

function renderTreeHtml(labelEntries: Array<{ id: string; label: string | undefined }>): string {
	const timestamp = "2026-11-14T00:00:00.000Z";
	const entries: object[] = [
		{
			type: "message",
			id: "u1",
			parentId: null,
			timestamp,
			message: { role: "user", content: "hello", timestamp: 0 },
		},
	];
	let parentId = "u1";
	for (const { id, label } of labelEntries) {
		entries.push({ type: "label", id, parentId, timestamp, targetId: "u1", label });
		parentId = id;
	}
	const sessionData = {
		header: { type: "session", version: 3, id: "s1", timestamp, cwd: "/tmp" },
		entries,
		leafId: parentId,
		systemPrompt: "",
		tools: [],
		renderedTools: {},
	};
	const dom = createRecordingDom(Buffer.from(JSON.stringify(sessionData)).toString("base64"));
	runInNewContext(templateJs, dom.context);
	return dom.html.join("\n");
}

describe("export HTML labels", () => {
	it("shows the current label of an entry", () => {
		expect(renderTreeHtml([{ id: "l1", label: "checkpoint" }])).toContain(
			'<span class="tree-label">[checkpoint]</span>',
		);
	});

	it("does not show a label that was cleared later", () => {
		const html = renderTreeHtml([
			{ id: "l1", label: "checkpoint" },
			{ id: "l2", label: undefined },
		]);
		expect(html).toContain("tree-role-user");
		expect(html).not.toContain("tree-label");
	});
});
