import assert from "node:assert/strict";
import { test } from "node:test";
import { checklistBody, fixture, interval } from "./periodic_scheduler_fixture.mjs";

test("manual run starts immediately while main busy and pending without moving timer", async (t) => {
	const f = await fixture(t);
	f.emit("session_start");
	f.busy(true);
	f.pending(true);
	await f.tick(60000);
	const before = await f.status();
	const launching = f.status("run");
	assert.equal(f.calls.length, 1, "manual dispatch precedes async yield");
	assert.match(f.notifications.at(-1).text, /starting/i);
	await launching;
	await f.flush();
	assert.match(f.notifications.at(-1).text, /started/i);
	assert.equal(await f.status(), before);
	assert.equal(f.ctx.isIdle(), false);
	assert.equal(f.ctx.hasPendingMessages(), true);
	assert.deepEqual(f.messages, []);
	for (let repeat = 0; repeat < 2; repeat++) {
		assert.match(await f.status("run"), /already.*live/i);
		assert.equal(f.calls.length, 1);
		assert.equal(await f.status(), before);
	}
	f.finishAudit();
	await f.status("run");
	assert.equal(f.calls.length, 2);
	assert.equal(await f.status(), before);
	f.finishAudit();
	await f.tick(interval - 60001);
	assert.equal(f.calls.length, 2);
	await f.tick(1);
	assert.equal(f.calls.length, 3, "timer retains original scheduled boundary");
	assert.deepEqual(f.calls[0].params, f.calls[2].params, "same report-only prompt and dispatch contract");
});

test("manual pending spawn refuses duplicates and timer overlap without awaiting child", async (t) => {
	const f = await fixture(t);
	const slow = deferred();
	f.setSpawn(() => slow.promise);
	f.emit("session_start");
	assert.match(await f.status("run"), /starting/i);
	assert.equal(f.calls.length, 1);
	assert.match(await f.status("run"), /already.*starting/i);
	await f.tick();
	assert.equal(f.calls.length, 1);
	slow.resolve(spawned());
	await f.flush();
	assert.match(f.notifications.at(-1).text, /started/i);
	assert.match(await f.status(), /Next run: in 30 minutes/);
});

for (const terminal of ["completed", "failed", "aborted"]) {
	test(`manual run accepts another audit after child ${terminal}`, async (t) => {
		const f = await fixture(t);
		f.emit("session_start");
		await f.status("run");
		f.agents[0].lifecycle = terminal;
		await f.status("run");
		assert.equal(f.calls.length, 2);
		assert.match(await f.status(), /Next run: in 30 minutes/);
	});
}

test("manual removal stops timer before checking pending spawn and never rearms", async (t) => {
	const f = await fixture(t);
	const slow = deferred();
	f.setSpawn(() => slow.promise);
	f.emit("session_start");
	await f.status("run");
	f.removeChecklist();
	assert.match(await f.status("run"), /Checklist removed/);
	assert.match(await f.status(), /disabled.*\n[\s\S]*Checklist removed/);
	f.restoreChecklist();
	slow.resolve(spawned());
	await f.flush();
	assert.match(await f.status("run"), /Checklist removed/);
	await f.tick(interval * 2);
	assert.equal(f.calls.length, 1);
	assert.ok(!f.notifications.some(({ text }) => /started/i.test(text)));
});

function applyUnavailableSchedule(f, unavailable) {
	if (unavailable === "missing") f.removeChecklist();
	if (unavailable === "invalid") f.restoreChecklist(checklistBody);
	if (unavailable === "invalid") assert.throws(() => f.emit("session_start"));
	else if (unavailable !== "not started") f.emit("session_start");
	if (unavailable === "shutdown") f.emit("session_shutdown");
	if (unavailable === "runtime") f.ctx.multiAgentStore = undefined;
	if (unavailable === "identity") f.switchIdentity();
	if (unavailable === "project") f.ctx.cwd = f.secondProject;
	if (unavailable === "tools") f.disableTools();
}

for (const unavailable of [
	"not started",
	"missing",
	"invalid",
	"shutdown",
	"runtime",
	"identity",
	"project",
	"tools",
]) {
	test(`manual run refuses ${unavailable} schedule`, async (t) => {
		const f = await fixture(t);
		applyUnavailableSchedule(f, unavailable);
		const notice = await f.status("run");
		assert.match(notice, /Cannot run periodic audit:/);
		assert.equal(f.notifications.at(-1).type, "warning");
		assert.equal(f.calls.length, 0);
	});
}

for (const failure of ["tool error", "blocked", "not dispatched", "rejection"]) {
	test(`manual ${failure} emits diagnostic without false started success`, async (t) => {
		const f = await fixture(t);
		f.setSpawn(() => refuseSpawn(failure));
		f.emit("session_start");
		await f.status("run");
		await f.flush();
		assert.equal(f.calls.length, 1);
		const notice = f.notifications.at(-1);
		assert.equal(notice.type, "error");
		for (const text of [
			"spawn_agent",
			"main-session",
			f.checklist,
			failure === "rejection" ? "Approval rejected" : "Policy refused audit",
		]) {
			assert.ok(notice.text.includes(text));
		}
		assert.ok(!f.notifications.some(({ text }) => /started/i.test(text)));
		assert.match(await f.status(), /Next run: in 30 minutes/);
		await f.status("run");
		assert.equal(f.calls.length, 2, "failure releases pending lock");
	});
}

function deferred() {
	let resolve;
	let reject;
	const promise = new Promise((yes, no) => {
		resolve = yes;
		reject = no;
	});
	return { promise, resolve, reject };
}

function spawned(id = "slow-audit") {
	return {
		content: [{ type: "text", text: "Spawned audit" }],
		details: { agent: { id }, dispatched: true, prompt: "audit" },
	};
}

for (const state of ["busy", "pending", "busy and pending"]) {
	test(`${state} main dispatches immediately without prompting or changing main state`, async (t) => {
		const f = await fixture(t);
		f.emit("session_start");
		f.busy(state.includes("busy"));
		f.pending(state.includes("pending"));
		const before = [f.ctx.isIdle(), f.ctx.hasPendingMessages()];
		const ticking = f.tick();
		assert.equal(f.calls.length, 1, "tool call starts before yielding");
		assert.equal(f.calls[0].name, "spawn_agent");
		assert.deepEqual(f.messages, []);
		assert.deepEqual([f.ctx.isIdle(), f.ctx.hasPendingMessages()], before);
		await ticking;
		assert.match(await f.status(), /armed[\s\S]*Next run: in 30 minutes/);
		assert.equal(f.calls.length, 1, "status cannot spawn");
	});
}

test("busy manual status displays immediately without resetting deadline", async (t) => {
	const f = await fixture(t);
	f.emit("session_start");
	f.busy(true);
	f.pending(true);
	await f.tick(interval - 1);
	const reading = f.status();
	assert.equal(f.notifications.length, 1, "notification precedes async yield");
	assert.match(await reading, /Next run: in less than a minute/);
	assert.equal(f.calls.length, 0);
	assert.equal(f.ctx.isIdle(), false);
	assert.equal(f.ctx.hasPendingMessages(), true);
	await f.tick(1);
	assert.equal(f.calls.length, 1);
});

test("slow spawn holds lock across ticks and main completion before store publication", async (t) => {
	const f = await fixture(t);
	const slow = deferred();
	f.setSpawn(() => slow.promise);
	f.emit("session_start");
	await f.tick();
	await f.tick();
	f.emit("agent_end", { messages: [], sessionContinuation: "cwd_relocation" });
	await f.tick();
	assert.equal(f.calls.length, 1);
	slow.resolve(spawned());
	await f.flush();
	await f.tick();
	assert.equal(f.calls.length, 2, "settled spawn releases pending lock");
});

for (const terminal of ["completed", "failed", "aborted"]) {
	test(`actual live child suppresses overlap; ${terminal} releases without main agent_end`, async (t) => {
		const f = await fixture(t);
		f.emit("session_start");
		await f.tick();
		for (const lifecycle of ["pending", "running", "waiting_for_input"]) {
			f.agents[0].lifecycle = lifecycle;
			await f.tick();
			assert.equal(f.calls.length, 1);
		}
		f.agents[0].lifecycle = terminal;
		assert.equal(f.calls.length, 1, "no completion-triggered dispatch");
		await f.tick();
		assert.equal(f.calls.length, 2);
	});
}

test("restored live audit survives reload; unrelated children do not block", async (t) => {
	const f = await fixture(t);
	f.agents.push({
		id: "restored",
		displayName: "periodic-checks-audit",
		lifecycle: "running",
	});
	f.agents.push({
		id: "work",
		displayName: "implementation",
		lifecycle: "running",
	});
	f.emit("session_start");
	await f.tick();
	assert.equal(f.calls.length, 0);
	f.emit("session_start", { reason: "reload" });
	await f.tick();
	assert.equal(f.calls.length, 0);
	assert.equal(f.agents[0].lifecycle, "running");
	f.agents[0].lifecycle = "completed";
	await f.tick();
	assert.equal(f.calls.length, 1);
});

function refuseSpawn(failure) {
	if (failure === "rejection") return Promise.reject(new Error("Approval rejected"));
	return Promise.resolve({
		content: [{ type: "text", text: "Policy refused audit" }],
		isError: failure !== "not dispatched",
		details:
			failure === "blocked"
				? {}
				: {
						agent: { id: "failed-child" },
						dispatched: false,
						prompt: "audit",
					},
	});
}

async function transitionSchedule(f, transition, newSpawn) {
	if (transition !== "reload") f.emit("session_shutdown");
	if (transition === "replacement") f.switchIdentity();
	if (transition === "shutdown") return;
	f.setSpawn(() => newSpawn.promise);
	f.emit("session_start", { reason: transition });
	await f.tick(interval - 1);
	assert.equal(f.calls.length, 1);
	await f.tick(1);
	assert.equal(f.calls.length, 2);
}

function settleSpawn(spawn, settlement) {
	if (settlement === "rejection") {
		spawn.reject(new Error("Old approval rejected"));
		return;
	}
	spawn.resolve(
		settlement === "success"
			? spawned("old")
			: {
					isError: true,
					content: [{ type: "text", text: "Old error" }],
					details: {},
				},
	);
}

for (const failure of ["tool error", "blocked", "not dispatched", "rejection"]) {
	test(`${failure} reports spawn context and releases pending lock`, async (t) => {
		const f = await fixture(t);
		f.setSpawn(() => refuseSpawn(failure));
		f.emit("session_start");
		await f.tick();
		assert.equal(f.notifications.length, 1);
		const notice = f.notifications[0];
		assert.equal(notice.type, "error");
		for (const text of [
			"spawn_agent",
			"main-session",
			f.checklist,
			failure === "rejection" ? "Approval rejected" : "Policy refused audit",
		]) {
			assert.ok(notice.text.includes(text), `missing error context: ${text}`);
		}
		await f.tick();
		assert.equal(f.calls.length, 2);
		assert.equal(f.notifications.length, 2);
	});
}

for (const transition of ["reload", "shutdown", "replacement"]) {
	for (const settlement of ["success", "error", "rejection"]) {
		test(`${transition} fences late ${settlement} from new schedule and diagnostics`, async (t) => {
			const f = await fixture(t);
			const oldSpawn = deferred();
			const newSpawn = deferred();
			f.setSpawn(() => oldSpawn.promise);
			f.emit("session_start");
			await f.tick();
			await transitionSchedule(f, transition, newSpawn);
			settleSpawn(oldSpawn, settlement);
			await f.flush();
			assert.deepEqual(f.notifications, []);
			await f.tick(interval * 2);
			assert.equal(f.calls.length, transition === "shutdown" ? 1 : 2, "late result cannot unlock new pending spawn");
			newSpawn.resolve(spawned("new"));
			await f.flush();
		});
	}
}
