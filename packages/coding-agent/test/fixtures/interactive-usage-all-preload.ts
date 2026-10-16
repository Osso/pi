import "../suite/fixtures/interactive-pty-provider-preload.ts";
import { appendFileSync } from "node:fs";
// Capture native fetch before installing the override, as in the busy usage fixture.
import "../../src/core/http-dispatcher.ts";

// Never allow this real CLI process to contact a live provider.
globalThis.fetch = async (input, init) => {
	const url = input instanceof Request ? input.url : String(input);
	if (url !== "https://chatgpt.com/backend-api/wham/usage") {
		throw new Error(`Unexpected fetch in usage-all PTY fixture: ${url}`);
	}
	const log = process.env.PI_TEST_USAGE_FETCH_LOG;
	if (!log) throw new Error("PI_TEST_USAGE_FETCH_LOG is required");
	const account = new Headers(init?.headers).get("chatgpt-account-id");
	appendFileSync(log, `${JSON.stringify({ account })}\n`);
	if (account === "usage-all-gc") return new Response("Fixture account unavailable", { status: 500 });
	if (account !== "usage-all-personal") throw new Error(`Unexpected usage account: ${account}`);
	return Response.json({
		plan_type: "pro",
		rate_limit: {
			primary_window: { used_percent: 23, limit_window_seconds: 18000, reset_at: 1893456000 },
			secondary_window: { used_percent: 41, limit_window_seconds: 604800, reset_at: 1894060800 },
		},
	});
};
