import { appendFileSync, existsSync } from "node:fs";
import { AgentSession } from "../../../src/core/agent-session.ts";

// Install real SDK subscribers before RPC subscribes, including after process restart.
const subscribed = new WeakSet<AgentSession>();
const subscribe = AgentSession.prototype.subscribe;
AgentSession.prototype.subscribe = function (listener) {
	if (!subscribed.has(this)) {
		subscribed.add(this);
		subscribe.call(this, (event) => {
			const armedPath = process.env.PI_TEST_LISTENER_ARMED;
			if (event.type === "queue_update" && armedPath && existsSync(armedPath)) {
				throw new Error("headless queue subscriber failed");
			}
		});
		subscribe.call(this, (event) => {
			const logPath = process.env.PI_TEST_LISTENER_LOG;
			if (event.type === "queue_update" && logPath) {
				appendFileSync(logPath, `${JSON.stringify({ type: "queue_update", sessionId: this.sessionId })}\n`);
			}
		});
	}
	return subscribe.call(this, listener);
};

const reportError = console.error;
console.error = (...args: unknown[]) => {
	reportError(...args);
	const logPath = process.env.PI_TEST_LISTENER_LOG;
	if (logPath && args[0] === "Session event listener error (queue_update):") {
		appendFileSync(logPath, `${JSON.stringify({ type: "reported", error: String(args[1]) })}\n`);
	}
};
