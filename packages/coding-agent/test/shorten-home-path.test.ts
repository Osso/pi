import { afterEach, describe, expect, it } from "vitest";
import { shortenPath } from "../src/core/tools/render-utils.ts";

describe("tool path display", () => {
	const previousHome = process.env.HOME;
	afterEach(() => {
		process.env.HOME = previousHome;
	});

	it("abbreviates only paths inside the home directory", () => {
		process.env.HOME = "/home/alex";

		expect(shortenPath("/home/alex")).toBe("~");
		expect(shortenPath("/home/alex/notes.txt")).toBe("~/notes.txt");
		expect(shortenPath("/home/alex-other/notes.txt")).toBe("/home/alex-other/notes.txt");
		expect(shortenPath("/home/alexander")).toBe("/home/alexander");
		expect(shortenPath("src/notes.txt")).toBe("src/notes.txt");
	});
});
