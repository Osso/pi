import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import {
	fixture,
	interval,
	checklistBody,
	checklistContent,
	configuredChecklist,
	git,
} from "./periodic_scheduler_fixture.mjs";
import "./periodic_scheduler_dispatch.mjs";

test("status reports armed schedule without changing metadata or original deadline", async (t) => {
	const f = await fixture(t);
	f.restoreChecklist(configuredChecklist(60));
	f.emit("session_start");
	await f.tick(30000);
	f.restoreChecklist(checklistBody);
	for (const args of ["status", "", "  status  "]) {
		assert.equal(
			await f.status(args),
			`Periodic checks: armed\nChecklist: ${f.checklist}\ninterval_seconds: 60\nNext run: in less than a minute`,
		);
	}
	assert.equal(f.calls.length, 0);
	await f.tick(29999);
	assert.equal(f.calls.length, 0);
	await f.tick(1);
	assert.equal(f.calls.length, 1);
});

test("status counts down without auditing, rereading metadata or resetting the original tick", async (t) => {
	const f = await fixture(t);
	f.emit("session_start");
	f.restoreChecklist(checklistBody);
	for (const [elapsed, expected] of [
		[0, "Next run: in 30 minutes"],
		[60000, "Next run: in 29 minutes"],
		[28 * 60000, "Next run: in 1 minute"],
		[1, "Next run: in less than a minute"],
	]) {
		await f.tick(elapsed);
		for (let repeat = 0; repeat < 2; repeat++) {
			assert.equal(
				await f.status(),
				`Periodic checks: armed\nChecklist: ${f.checklist}\ninterval_seconds: 1800\n${expected}`,
			);
			assert.equal(f.notifications.at(-1).type, "info");
		}
		assert.equal(f.calls.length, 0);
	}
	await f.tick(59998);
	assert.equal(f.calls.length, 0);
	await f.tick(1);
	assert.equal(f.calls.length, 1);
});

test("status rounds 90 seconds up to 2 minutes", async (t) => {
	const f = await fixture(t);
	f.restoreChecklist(configuredChecklist(90));
	f.emit("session_start");
	assert.equal(
		await f.status(),
		`Periodic checks: armed\nChecklist: ${f.checklist}\ninterval_seconds: 90\nNext run: in 2 minutes`,
	);
});

test("status clamps due and overdue ticks to less than a minute without dispatch", async (t) => {
	const f = await fixture(t);
	f.emit("session_start");
	const start = Date.now();
	for (const elapsed of [interval, interval + 1, interval + 60000]) {
		t.mock.timers.setTime(start + elapsed);
		assert.equal(
			await f.status(),
			`Periodic checks: armed\nChecklist: ${f.checklist}\ninterval_seconds: 1800\nNext run: in less than a minute`,
		);
		assert.equal(f.calls.length, 0);
	}
});

test("status rejects controls and extra arguments without resetting deadline", async (t) => {
	const f = await fixture(t);
	f.emit("session_start");
	await f.tick(interval - 1);
	for (const args of ["start", "stop", "status extra", "run extra"]) {
		assert.equal(await f.status(args), "Usage: /periodic-checks status|run");
		assert.equal(f.notifications.at(-1).type, "warning");
	}
	assert.equal(f.calls.length, 0);
	await f.tick(1);
	assert.equal(f.calls.length, 1);
});

test("status records missing checklist without rearming on restoration", async (t) => {
	const f = await fixture(t);
	f.removeChecklist();
	f.emit("session_start");
	assert.equal(await f.status(), `Periodic checks: disabled\nChecklist: ${f.checklist}\nReason: No checklist`);
	f.restoreChecklist();
	await f.status();
	await f.tick(interval * 2);
	assert.equal(f.calls.length, 0);
});

test("status preserves explicit invalid metadata startup error and disabled state", async (t) => {
	const f = await fixture(t);
	f.emit("session_start");
	f.restoreChecklist(checklistBody);
	let startupError;
	assert.throws(
		() => f.emit("session_start"),
		(error) => {
			startupError = error.message;
			return error.message.includes(f.checklist);
		},
	);
	assert.equal(await f.status(), `Periodic checks: disabled\nChecklist: ${f.checklist}\nReason: ${startupError}`);
	f.restoreChecklist();
	await f.status();
	await f.tick(interval * 2);
	assert.equal(f.calls.length, 0);
});

test("status restart resets interval, checklist and scheduled boundary", async (t) => {
	const f = await fixture(t);
	f.emit("session_start");
	await f.tick(30000);
	f.emit("session_shutdown");
	assert.match(await f.status(), /disabled[\s\S]*Reason: Session shutdown/);
	assert.ok((await f.status()).includes(f.checklist));
	f.ctx.cwd = f.secondProject;
	writeFileSync(join(f.secondProject, "periodic-checks.md"), configuredChecklist(60));
	f.emit("session_start", { reason: "restart" });
	assert.equal(
		await f.status(),
		`Periodic checks: armed\nChecklist: ${join(f.secondProject, "periodic-checks.md")}\ninterval_seconds: 60\nNext run: in 1 minute`,
	);
	await f.tick(59999);
	assert.equal(f.calls.length, 0);
	await f.tick(1);
	assert.equal(f.calls.length, 1);
});

test("status reflects removal only after scheduled tick and never restarts timer", async (t) => {
	const f = await fixture(t);
	f.emit("session_start");
	f.removeChecklist();
	assert.match(await f.status(), /Periodic checks: armed/);
	f.busy(true);
	await f.tick();
	assert.equal(await f.status(), `Periodic checks: disabled\nChecklist: ${f.checklist}\nReason: Checklist removed`);
	f.restoreChecklist();
	f.busy(false);
	await f.status();
	await f.tick(interval * 2);
	assert.equal(f.calls.length, 0);
});

test("status explains unsupported runtimes and missing tools", async (t) => {
	for (const [overrides, tools, reason] of [
		[{ multiAgentAgentId: "child-1" }, undefined, "Child session"],
		[{ multiAgentRequiresAgentId: true }, undefined, "Child session"],
		[{ mode: "print" }, undefined, "Unsupported runtime mode: print"],
		[{ multiAgentStore: undefined }, undefined, "Missing multi-agent runtime store"],
		[{}, ["send_agent_message"], "Missing required tools: spawn_agent"],
		[{}, ["spawn_agent"], "Missing required tools: send_agent_message"],
	]) {
		await t.test(reason, async (t) => {
			const f = await fixture(t, overrides, tools);
			f.emit("session_start");
			assert.equal(await f.status(), `Periodic checks: disabled\nReason: ${reason}`);
			await f.tick(interval);
			assert.equal(f.calls.length, 0);
		});
	}
});

test("status explains non-Git cwd without stale checklist or interval", async (t) => {
	const f = await fixture(t);
	f.emit("session_start");
	f.ctx.cwd = f.home;
	f.emit("session_start");
	assert.equal(await f.status(), "Periodic checks: disabled\nReason: Not a Git project");
	await f.tick(interval);
	assert.equal(f.calls.length, 0);
});

test("1800-second metadata delays first and recurring bounded report-only audit", async (t) => {
	const f = await fixture(t);
	await f.tick();
	assert.equal(f.calls.length, 0, "factory must not start a timer");
	f.emit("session_start");
	f.emit("agent_end", { messages: [] });
	await f.tick(interval - 1);
	assert.equal(f.calls.length, 0);
	await f.tick(1);
	assert.equal(f.calls.length, 1);
	const { name, params } = f.calls[0];
	assert.equal(name, "spawn_agent");
	assert.equal(params.agentType, "explore");
	assert.equal(params.context, "fresh");
	assert.equal(params.displayName, "periodic-checks-audit");
	for (const text of [
		"read-only",
		"bounded",
		"send_agent_message",
		"worktree",
		"disk",
		"build",
		"error",
		"delegation",
		"headroom",
		"no cleanup",
		"no blocking",
		"no cancellation",
		"no steering",
		"periodic-checks.md",
		"no edits or deployment",
		"no nested spawn",
		"other agents",
		"no builds",
		"no operational mutation",
		"only the checklist",
	]) {
		assert.ok(params.prompt.includes(text), `missing audit instruction: ${text}`);
	}
	assert.ok(params.prompt.includes(f.checklist));
	f.finishAudit();
	await f.tick(interval - 1);
	assert.equal(f.calls.length, 1);
	await f.tick(1);
	assert.equal(f.calls.length, 2, "recurring audit exactly 30 minutes later");
});

for (const seconds of [60, 1, 2147483]) {
	test(`${seconds}-second metadata delays first and recurring audit`, async (t) => {
		const f = await fixture(t);
		f.restoreChecklist(configuredChecklist(seconds));
		f.emit("session_start");
		const delay = seconds * 1000;
		await f.tick(delay - 1);
		assert.equal(f.calls.length, 0);
		await f.tick(1);
		assert.equal(f.calls.length, 1);
		f.finishAudit();
		await f.tick(delay - 1);
		assert.equal(f.calls.length, 1);
		await f.tick(1);
		assert.equal(f.calls.length, 2);
	});
}

const invalidChecklists = [
	["missing frontmatter", checklistBody],
	["unclosed frontmatter", "---\ntype: Periodic Checks\ninterval_seconds: 60\n"],
	["bad opening delimiter", "---oops\ntype: Periodic Checks\ninterval_seconds: 60\n---\n"],
	["bad closing delimiter", "---\ntype: Periodic Checks\ninterval_seconds: 60\n---oops\n"],
	["empty metadata", "---\n---\n"],
	["sequence metadata", "---\n- Periodic Checks\n- 60\n---\n"],
	["scalar metadata", "---\nPeriodic Checks\n---\n"],
	["missing type", "---\ninterval_seconds: 60\n---\n"],
	["missing interval", "---\ntype: Periodic Checks\n---\n"],
	["duplicate type", "---\ntype: First\ntype: Second\ninterval_seconds: 60\n---\n"],
	["duplicate interval", "---\ntype: Periodic Checks\ninterval_seconds: 60\ninterval_seconds: 1800\n---\n"],
	["malformed YAML", "---\ntype: Periodic Checks\ninterval_seconds: [60\n---\n"],
	["malformed indentation", "---\ntype: Periodic Checks\ninterval_seconds:\n\tvalue: 60\n---\n"],
	...["''", "'  '", "null", "123", "[]", "{}"].map((value) => [
		`invalid type ${value}`,
		`---\ntype: ${value}\ninterval_seconds: 60\n---\n`,
	]),
	...[
		"0",
		"-1",
		"0.5",
		"1.5",
		".nan",
		".inf",
		"-.inf",
		"9007199254740992",
		"2147484",
		"'60'",
		"true",
		"null",
		"[]",
		"{}",
	].map((value) => [`invalid interval ${value}`, configuredChecklist(value)]),
];

for (const [label, content] of invalidChecklists) {
	test(`${label} reports checklist path and never schedules`, async (t) => {
		const f = await fixture(t);
		f.restoreChecklist(content);
		assert.throws(
			() => f.emit("session_start"),
			(error) => {
				assert.ok(error instanceof Error);
				assert.ok(error.message.includes(f.checklist));
				assert.match(error.message, /metadata/i);
				return true;
			},
		);
		await f.tick(interval * 3);
		assert.equal(f.calls.length, 0);
	});
}

test("standard YAML unknown nested keys, aliases, flow mappings, and block strings are accepted", async (t) => {
	const f = await fixture(t);
	f.restoreChecklist(
		`---\ntype: >-\n  Custom Checks\ninterval_seconds: &delay 60\nfuture: {copied_delay: *delay, tags: [one, two]}\nnotes: |\n  Unknown multiline metadata\n  is allowed.\n---\n${checklistBody}`,
	);
	f.emit("session_start");
	await f.tick(59999);
	assert.equal(f.calls.length, 0);
	await f.tick(1);
	assert.equal(f.calls.length, 1);
});

test("CRLF frontmatter supports quoted YAML keys and values", async (t) => {
	const f = await fixture(t);
	f.restoreChecklist('---\r\n"type": \'Periodic Checks\'\r\n"interval_seconds": 60 # seconds\r\n---\r\nBody\r\n');
	f.emit("session_start");
	await f.tick(60000);
	assert.equal(f.calls.length, 1);
});

test("reload and restart reread metadata and wait the full new delay", async (t) => {
	const f = await fixture(t);
	f.restoreChecklist(configuredChecklist(60));
	f.emit("session_start");
	await f.tick(59000);
	f.restoreChecklist(configuredChecklist(1800));
	f.emit("session_start", { reason: "reload" });
	await f.tick(interval - 1);
	assert.equal(f.calls.length, 0);
	await f.tick(1);
	assert.equal(f.calls.length, 1);
	f.emit("session_shutdown");
	f.finishAudit();
	f.restoreChecklist(configuredChecklist(60));
	f.emit("session_start", { reason: "restart" });
	await f.tick(59999);
	assert.equal(f.calls.length, 1);
	await f.tick(1);
	assert.equal(f.calls.length, 2);
});

test("metadata edits do not change an armed delay until session_start", async (t) => {
	const f = await fixture(t);
	f.restoreChecklist(configuredChecklist(60));
	f.emit("session_start");
	f.restoreChecklist(configuredChecklist(1800));
	await f.tick(60000);
	assert.equal(f.calls.length, 1);
});

test("invalid metadata on reload clears the previously armed timer", async (t) => {
	const f = await fixture(t);
	f.emit("session_start");
	await f.tick(interval - 1);
	f.restoreChecklist(checklistBody);
	assert.throws(() => f.emit("session_start", { reason: "reload" }));
	await f.tick(interval * 3);
	assert.equal(f.calls.length, 0);
});

test("audit prompt routes child findings to originating main session and confirms mailbox receipt", async (t) => {
	const f = await fixture(t);
	f.emit("session_start");
	await f.tick();
	assert.equal(f.calls.length, 1);
	const prompt = f.calls[0].params.prompt;
	assert.ok(prompt.includes('send_agent_message with toAgentId "main" AND toSessionId "main-session"'));
	assert.ok(prompt.includes("Check the tool result and confirm successful delivery"));
	assert.ok(prompt.includes("no wait_agent recovery"));
});

test("replacement and restarted sessions route audits to current parent identity", async (t) => {
	const f = await fixture(t);
	f.emit("session_start");
	await f.tick();
	assert.equal(f.calls.length, 1);
	assert.ok(f.calls[0].params.prompt.includes('toSessionId "main-session"'));
	f.finishAudit();
	for (const [reason, sessionId] of [
		["replacement", "replacement-main-session"],
		["restart", "restarted-main-session"],
	]) {
		if (reason === "restart") f.emit("session_shutdown");
		f.switchIdentity(sessionId);
		f.emit("session_start", { reason });
		await f.tick();
		const prompt = f.calls.at(-1).params.prompt;
		assert.ok(prompt.includes(`toSessionId "${sessionId}"`));
		assert.ok(!prompt.includes('toSessionId "main-session"'));
		f.finishAudit();
	}
	assert.equal(f.calls.length, 3);
});

test("second Git project opts in without remote-agent mapping", async (t) => {
	const f = await fixture(t);
	f.ctx.cwd = f.secondProject;
	f.emit("session_start");
	await f.tick();
	assert.equal(f.calls.length, 1);
	assert.ok(f.calls[0].params.prompt.includes(join(f.secondProject, "periodic-checks.md")));
	assert.ok(!f.calls[0].params.prompt.includes(f.checklist));
});

test("nested cwd discovers checklist at Git project root", async (t) => {
	const f = await fixture(t);
	f.ctx.cwd = join(f.project, "src/nested");
	mkdirSync(f.ctx.cwd, { recursive: true });
	writeFileSync(join(f.ctx.cwd, "periodic-checks.md"), "Not the project checklist");
	f.emit("session_start");
	await f.tick();
	assert.equal(f.calls.length, 1);
	assert.ok(f.calls[0].params.prompt.includes(f.checklist));
	assert.ok(!f.calls[0].params.prompt.includes(join(f.ctx.cwd, "periodic-checks.md")));
});

test("Git worktree uses its own checklist, not canonical checkout", async (t) => {
	const f = await fixture(t);
	git(f.project, "add", "periodic-checks.md");
	git(
		f.project,
		"-c",
		"user.name=Periodic Test",
		"-c",
		"user.email=periodic@example.test",
		"-c",
		"commit.gpgsign=false",
		"-c",
		"core.hooksPath=/dev/null",
		"commit",
		"--quiet",
		"-m",
		"Add checklist",
	);
	const worktree = join(f.home, "linked-worktree");
	git(f.project, "worktree", "add", "--quiet", "--detach", worktree);
	f.removeChecklist();
	f.ctx.cwd = join(worktree, "src");
	mkdirSync(f.ctx.cwd);
	f.emit("session_start");
	await f.tick();
	assert.equal(f.calls.length, 1);
	assert.ok(f.calls[0].params.prompt.includes(join(worktree, "periodic-checks.md")));
	assert.ok(!f.calls[0].params.prompt.includes(f.checklist));
});

test("every session_start rearms from zero; shutdown clears; stale identity cannot fire", async (t) => {
	const f = await fixture(t);
	f.emit("session_start");
	await f.tick(interval - 1);
	f.emit("session_start", { reason: "reload" });
	await f.tick(interval - 1);
	assert.equal(f.calls.length, 0);
	await f.tick(1);
	assert.equal(f.calls.length, 1);
	f.emit("session_shutdown");
	await f.tick(interval * 3);
	assert.equal(f.calls.length, 1);
	f.finishAudit();
	f.emit("session_start", { reason: "resume" });
	await f.tick(interval - 1);
	assert.equal(f.calls.length, 1);
	await f.tick(1);
	assert.equal(f.calls.length, 2);
	f.finishAudit();
	f.switchIdentity();
	await f.tick();
	assert.equal(f.calls.length, 2);
});

test("only supported Pi main runtimes arm", async (t) => {
	for (const [label, overrides, tools] of [
		["child", { multiAgentAgentId: "child-1" }],
		["child awaiting identity", { multiAgentRequiresAgentId: true }],
		["print", { mode: "print" }],
		["json", { mode: "json" }],
		["missing runtime store", { multiAgentStore: undefined }],
		["missing delegation", {}, ["send_agent_message"]],
		["missing mailbox", {}, ["spawn_agent"]],
	]) {
		await t.test(label, async (t) => {
			const f = await fixture(t, overrides, tools);
			f.emit("session_start");
			await f.tick(interval * 2);
			assert.equal(f.calls.length, 0);
		});
	}
});

test("absent checklist disables scheduling until restored and session_start fires", async (t) => {
	const f = await fixture(t);
	f.removeChecklist();
	f.emit("session_start");
	await f.tick();
	assert.equal(f.calls.length, 0, "absent checklist must not arm a timer");
	f.restoreChecklist();
	await f.tick(interval * 2);
	assert.equal(f.calls.length, 0, "restoration must not start polling audits");
	f.emit("session_start");
	await f.tick(interval - 1);
	assert.equal(f.calls.length, 0);
	await f.tick(1);
	assert.equal(f.calls.length, 1);
});

test("removed checklist prevents the next armed audit", async (t) => {
	const f = await fixture(t);
	f.emit("session_start");
	f.removeChecklist();
	await f.tick();
	assert.equal(f.calls.length, 0, "removed checklist must not audit");
});

test("removed checklist stops armed timer even while busy; restoration requires session_start", async (t) => {
	const f = await fixture(t);
	f.emit("session_start");
	f.busy(true);
	f.removeChecklist();
	await f.tick();
	assert.equal(f.calls.length, 0, "removed checklist must not audit");
	f.restoreChecklist();
	f.busy(false);
	await f.tick(interval * 2);
	assert.equal(f.calls.length, 0, "removed checklist must stop the timer");
	f.emit("session_start");
	await f.tick(interval - 1);
	assert.equal(f.calls.length, 0);
	await f.tick(1);
	assert.equal(f.calls.length, 1);
});

test("ticks remain scoped to startup project after cwd changes", async (t) => {
	const f = await fixture(t);
	f.emit("session_start");
	f.ctx.cwd = f.secondProject;
	await f.tick();
	assert.equal(f.calls.length, 0);
	f.emit("session_start");
	await f.tick();
	assert.equal(f.calls.length, 1);
	assert.ok(f.calls[0].params.prompt.includes(join(f.secondProject, "periodic-checks.md")));
});

test("non-Git directory with checklist cannot opt in", async (t) => {
	const f = await fixture(t);
	f.ctx.cwd = f.home;
	writeFileSync(join(f.home, "periodic-checks.md"), checklistContent);
	f.emit("session_start");
	await f.tick(interval * 2);
	assert.equal(f.calls.length, 0);
});
