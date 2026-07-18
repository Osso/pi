import { describe, expect, it } from "vitest";
import { AgentSession, type InteractiveModeOptions } from "../src/index.ts";

function assertPublicApiShape(): void {
	// @ts-expect-error The public AgentSession constructor must not accept an internal resolver.
	new AgentSession({} as never, () => undefined);
	// @ts-expect-error The public InteractiveModeOptions must not accept an internal resolver.
	const options: InteractiveModeOptions = { resolveSessionMutationTarget: () => undefined };
	void options;
}

describe("public viewed-session mutation API", () => {
	it("does not expose resolver injection on the public session or interactive APIs", () => {
		void assertPublicApiShape;
		expect(true).toBe(true);
	});
});
