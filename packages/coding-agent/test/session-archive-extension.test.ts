import { describe, expect, it } from "vitest";
import sessionArchiveExtension from "../extensions/session-archive/src/index.ts";
import type { ExtensionAPI, RegisteredCommand } from "../src/core/extensions/types.ts";

describe("session archive extension", () => {
	it("registers the archive slash command", () => {
		let command: RegisteredCommand | undefined;
		const pi = {
			registerCommand(name: string, options: Omit<RegisteredCommand, "name" | "sourceInfo">) {
				if (name === "archive") {
					command = {
						...options,
						name,
						sourceInfo: {
							path: "<test>",
							source: "test",
							scope: "temporary",
							origin: "top-level",
						},
					};
				}
			},
		} as unknown as ExtensionAPI;

		sessionArchiveExtension(pi);

		expect(command?.description).toContain("Archive completed sessions");
	});
});
