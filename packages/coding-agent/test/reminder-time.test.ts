import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { formatReminderDueAt, isReminderDueToday, parseReminderDueAt } from "../src/core/reminder-time.ts";

let originalTimezone: string | undefined;

beforeEach(() => {
	originalTimezone = process.env.TZ;
	process.env.TZ = "America/Chicago";
});

afterEach(() => {
	if (originalTimezone === undefined) delete process.env.TZ;
	else process.env.TZ = originalTimezone;
});

describe("parseReminderDueAt", () => {
	it.each([
		["2026-07-21T14:30Z", "2026-07-21T14:30:00.000Z"],
		["2026-07-21T14:30:12Z", "2026-07-21T14:30:12.000Z"],
		["2026-07-21T14:30:12.123Z", "2026-07-21T14:30:12.123Z"],
		["2026-07-21T14:30:12.1+05:45", "2026-07-21T08:45:12.100Z"],
		["2026-07-21T00:30+05:45", "2026-07-20T18:45:00.000Z"],
		["2026-12-31T23:30-06:00", "2027-01-01T05:30:00.000Z"],
		["2000-02-29T12:30:00+00:00", "2000-02-29T12:30:00.000Z"],
		["0099-01-02T03:04Z", "0099-01-02T03:04:00.000Z"],
		["0000-02-29T03:04Z", "0000-02-29T03:04:00.000Z"],
	])("canonicalizes explicit instant %s", (input, expected) => {
		expect(parseReminderDueAt(input)).toBe(expected);
	});

	it.each([
		["2026-07-21T14:30", "2026-07-21T19:30:00.000Z"],
		["2026-01-21 14:30:12", "2026-01-21T20:30:12.000Z"],
		["2026-07-21 14:30", "2026-07-21T19:30:00.000Z"],
		["2026-01-21T14:30:12", "2026-01-21T20:30:12.000Z"],
	])("uses Chicago local time for %s", (input, expected) => {
		expect(parseReminderDueAt(input)).toBe(expected);
	});

	it("uses the current timezone rather than caching it", () => {
		expect(parseReminderDueAt("2026-07-21T14:30")).toBe("2026-07-21T19:30:00.000Z");
		process.env.TZ = "UTC";
		expect(parseReminderDueAt("2026-07-21T14:30")).toBe("2026-07-21T14:30:00.000Z");
		expect(parseReminderDueAt("2026-11-01T01:30")).toBe("2026-11-01T01:30:00.000Z");
	});

	it.each([
		"",
		"tomorrow",
		"next Friday at noon",
		"2026",
		"2026-07-21",
		"14:30",
		"2026-7-21T14:30",
		"2026-07-21T4:30",
		"2026-07-21T14",
		"2026-07-21t14:30z",
		"2026-07-21T14:30+0500",
		"2026-07-21T14:30+05",
		"2026-07-21T14:30 America/Chicago",
		"2026-07-21T14:30[America/Chicago]",
		"2026-07-21 14:30Z",
		"2026-07-21T14:30:00.123",
		" 2026-07-21T14:30Z",
		"2026-07-21T14:30Z\n",
		"2026-07-21T14:30Z trailing",
		"2026-07-21T14:30:00.1234Z",
	])("rejects unsupported input %j with timezone guidance", (input) => {
		expect(() => parseReminderDueAt(input)).toThrow(/YYYY-MM-DD/);
		expect(() => parseReminderDueAt(input)).toThrow(/Z.*[+-]HH:MM/);
	});

	it.each([
		"2026-02-30T12:00Z",
		"2026-02-29T12:00Z",
		"1900-02-29T12:00Z",
		"2026-04-31T12:00Z",
		"2026-00-01T12:00Z",
		"2026-13-01T12:00Z",
		"2026-01-00T12:00Z",
		"2026-01-32T12:00Z",
		"2026-07-21T24:00Z",
		"2026-07-21T12:60Z",
		"2026-07-21T12:00:60Z",
		"2026-02-30 12:00",
		"2026-07-21T14:30+24:00",
		"2026-07-21T14:30-24:00",
		"2026-07-21T14:30+05:60",
	])("rejects invalid calendar, clock, or offset values in %s", (input) => {
		expect(() => parseReminderDueAt(input)).toThrow(/Invalid/);
		expect(() => parseReminderDueAt(input)).toThrow(/Z.*[+-]HH:MM/);
	});

	it.each(["2026-03-08T02:00", "2026-03-08 02:30:15", "2026-03-08T02:59:59"])(
		"rejects nonexistent Chicago spring time %s",
		(input) => {
			expect(() => parseReminderDueAt(input)).toThrow(/nonexistent/i);
			expect(() => parseReminderDueAt(input)).toThrow(/Z.*[+-]HH:MM/);
		},
	);

	it.each(["2026-11-01T01:00", "2026-11-01 01:30:15", "2026-11-01T01:59:59"])(
		"rejects ambiguous Chicago fall time %s",
		(input) => {
			expect(() => parseReminderDueAt(input)).toThrow(/ambiguous/i);
			expect(() => parseReminderDueAt(input)).toThrow(/Z.*[+-]HH:MM/);
		},
	);

	it("accepts valid times immediately around Chicago transitions", () => {
		expect(parseReminderDueAt("2026-03-08T01:59:59")).toBe("2026-03-08T07:59:59.000Z");
		expect(parseReminderDueAt("2026-03-08T03:00")).toBe("2026-03-08T08:00:00.000Z");
		expect(parseReminderDueAt("2026-11-01T00:59:59")).toBe("2026-11-01T05:59:59.000Z");
		expect(parseReminderDueAt("2026-11-01T02:00")).toBe("2026-11-01T08:00:00.000Z");
	});

	it("accepts either explicit offset during a repeated hour", () => {
		expect(parseReminderDueAt("2026-11-01T01:30-05:00")).toBe("2026-11-01T06:30:00.000Z");
		expect(parseReminderDueAt("2026-11-01T01:30-06:00")).toBe("2026-11-01T07:30:00.000Z");
		expect(parseReminderDueAt("2026-03-08T02:30-06:00")).toBe("2026-03-08T08:30:00.000Z");
	});

	it("detects Lord Howe half-hour DST gaps and overlaps", () => {
		process.env.TZ = "Australia/Lord_Howe";
		expect(() => parseReminderDueAt("2026-10-04T02:15")).toThrow(/nonexistent/i);
		expect(() => parseReminderDueAt("2026-04-05T01:45")).toThrow(/ambiguous/i);
		expect(parseReminderDueAt("2026-10-04T02:30")).toBe("2026-10-03T15:30:00.000Z");
		expect(parseReminderDueAt("2026-04-05T01:45+11:00")).toBe("2026-04-04T14:45:00.000Z");
		expect(parseReminderDueAt("2026-04-05T01:45+10:30")).toBe("2026-04-04T15:15:00.000Z");
	});
});

describe("formatReminderDueAt", () => {
	it("labels local summer and winter time with zone and actual UTC offset", () => {
		expect(formatReminderDueAt("2026-07-21T19:30:12.000Z")).toBe("2026-07-21 14:30:12 GMT-05:00 [America/Chicago]");
		expect(formatReminderDueAt("2026-01-21T20:30:12.000Z")).toBe("2026-01-21 14:30:12 GMT-06:00 [America/Chicago]");
	});

	it("distinguishes the two occurrences of a repeated local time", () => {
		expect(formatReminderDueAt("2026-11-01T06:30:00.000Z")).toBe("2026-11-01 01:30:00 GMT-05:00 [America/Chicago]");
		expect(formatReminderDueAt("2026-11-01T07:30:00.000Z")).toBe("2026-11-01 01:30:00 GMT-06:00 [America/Chicago]");
	});

	it("changes only presentation when the machine timezone changes", () => {
		const iso = parseReminderDueAt("2026-07-21T14:30");
		expect(formatReminderDueAt(iso)).toContain("14:30:00 GMT-05:00 [America/Chicago]");
		process.env.TZ = "UTC";
		expect(formatReminderDueAt(iso)).toMatch(/^2026-07-21 19:30:00 GMT(?:\+00:00)? \[UTC\]$/);
		expect(parseReminderDueAt(iso)).toBe("2026-07-21T19:30:00.000Z");
	});

	it.each(["not a date", "2026-02-30T12:00Z", "2026-07-21T14:30"])(
		"rejects invalid or non-absolute stored time %s",
		(iso) => {
			expect(() => formatReminderDueAt(iso)).toThrow();
		},
	);
});

describe("isReminderDueToday", () => {
	it("includes all overdue times, now, and the rest of the local day", () => {
		const now = new Date("2026-07-22T01:00:00Z"); // July 21, 20:00 in Chicago.
		for (const dueAt of [
			"2020-01-01T00:00:00Z",
			"2026-07-21T05:00:00Z",
			"2026-07-22T01:00:00Z",
			"2026-07-22T04:59:59.999Z",
		]) {
			expect(isReminderDueToday(dueAt, now), dueAt).toBe(true);
		}
		expect(isReminderDueToday("2026-07-22T05:00:00Z", now)).toBe(false);
		expect(isReminderDueToday("2027-01-01T00:00:00Z", now)).toBe(false);
		expect(now.toISOString()).toBe("2026-07-22T01:00:00.000Z");
	});

	it.each([
		["2026-03-08T06:00:00Z", "2026-03-09T04:59:59.999Z", "2026-03-09T05:00:00Z"],
		["2026-11-01T05:00:00Z", "2026-11-02T05:59:59.999Z", "2026-11-02T06:00:00Z"],
	])("uses local midnight across DST for %s", (now, lastToday, tomorrow) => {
		expect(isReminderDueToday(lastToday, new Date(now))).toBe(true);
		expect(isReminderDueToday(tomorrow, new Date(now))).toBe(false);
	});

	it("uses UTC day boundaries when the current machine zone is UTC", () => {
		process.env.TZ = "UTC";
		const now = new Date("2026-07-21T20:00:00Z");
		expect(isReminderDueToday("2026-07-21T23:59:59.999Z", now)).toBe(true);
		expect(isReminderDueToday("2026-07-22T00:00:00Z", now)).toBe(false);
	});

	it("rejects invalid instants and an invalid injected clock", () => {
		expect(() => isReminderDueToday("bad", new Date("2026-07-21T20:00Z"))).toThrow();
		expect(() => isReminderDueToday("2026-07-21T20:00Z", new Date(Number.NaN))).toThrow(/now/i);
	});
});
