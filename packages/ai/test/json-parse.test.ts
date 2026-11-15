import { describe, expect, it } from "vitest";
import { parseStreamingJson } from "../src/utils/json-parse.ts";

describe("parseStreamingJson", () => {
	// #10868
	it("keeps invalid \\u escapes as literal text without dropping fields", () => {
		expect(parseStreamingJson(String.raw`{"text":"\url{x}"}`)).toEqual({ text: "\\url{x}" });
		expect(parseStreamingJson(String.raw`{"path":"a.tex","content":"\usepackage{x}","mode":"w"}`)).toEqual({
			path: "a.tex",
			content: "\\usepackage{x}",
			mode: "w",
		});
	});

	it("decodes valid \\u escapes", () => {
		expect(parseStreamingJson(String.raw`{"text":"caf\u00e9 \url"}`)).toEqual({ text: "café \\url" });
	});

	it("omits a \\u escape that is cut off mid-stream", () => {
		expect(parseStreamingJson(String.raw`{"text":"ab\u00`)).toEqual({ text: "ab" });
	});

	it("omits a lone backslash that is cut off mid-stream", () => {
		expect(parseStreamingJson('{"text":"ab\\')).toEqual({ text: "ab" });
	});

	it("keeps every streamed field when unfinished arguments need repair", () => {
		expect(parseStreamingJson(String.raw`{"pattern":"\d+", "path":"src`)).toEqual({ pattern: "\\d+", path: "src" });
		expect(parseStreamingJson('{"a":"line1\nline2')).toEqual({ a: "line1\nline2" });
		expect(parseStreamingJson('{"path":"a.ts","content":"x\ty')).toEqual({ path: "a.ts", content: "x\ty" });
		expect(parseStreamingJson(String.raw`{"path":"C:\users`)).toEqual({ path: "C:\\users" });
	});
});
