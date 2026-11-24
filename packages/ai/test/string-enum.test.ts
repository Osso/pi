import { describe, expect, it } from "vitest";
import { StringEnum } from "../src/utils/typebox-helpers.ts";

describe("StringEnum", () => {
	it("keeps an empty-string default that is an enum member", () => {
		expect(JSON.parse(JSON.stringify(StringEnum(["", ".txt"], { default: "" })))).toEqual({
			type: "string",
			enum: ["", ".txt"],
			default: "",
		});
	});
});
