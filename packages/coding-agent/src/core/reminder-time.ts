const INPUT_GUIDANCE =
	"Use YYYY-MM-DDTHH:mm[:ss] or YYYY-MM-DD HH:mm[:ss] for local time; add Z or an explicit +/-HH:MM timezone offset to the T form to select an exact instant.";
const DATE_TIME_PATTERN =
	/^(\d{4})-(\d{2})-(\d{2})([T ])(\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,3}))?)?(Z|[+-]\d{2}:\d{2})?$/;
const DAY_MS = 86_400_000;

/** Parse a strict date and clock, rejecting local DST gaps and repeated times. */
export function parseReminderDueAt(input: string): string {
	const match = DATE_TIME_PATTERN.exec(input);
	if (!match || match[0] !== input) throw new Error(`Invalid reminder due time. ${INPUT_GUIDANCE}`);

	const [, year, month, day, separator, hour, minute, second, fraction, zone] = match;
	if ((zone && separator !== "T") || (fraction && !zone)) {
		throw new Error(`Invalid reminder due time format. ${INPUT_GUIDANCE}`);
	}

	const wallTime = new Date(0);
	wallTime.setUTCFullYear(Number(year), Number(month) - 1, Number(day));
	wallTime.setUTCHours(Number(hour), Number(minute), Number(second ?? 0), Number((fraction ?? "").padEnd(3, "0")));
	if (
		wallTime.getUTCFullYear() !== Number(year) ||
		wallTime.getUTCMonth() !== Number(month) - 1 ||
		wallTime.getUTCDate() !== Number(day) ||
		wallTime.getUTCHours() !== Number(hour) ||
		wallTime.getUTCMinutes() !== Number(minute) ||
		wallTime.getUTCSeconds() !== Number(second ?? 0)
	) {
		throw new Error(`Invalid calendar date or clock time. ${INPUT_GUIDANCE}`);
	}

	if (!zone) return resolveLocalTime(wallTime.getTime()).toISOString();
	if (zone === "Z") return wallTime.toISOString();

	const offsetHours = Number(zone.slice(1, 3));
	const offsetMinutes = Number(zone.slice(4, 6));
	if (offsetHours > 23 || offsetMinutes > 59) {
		throw new Error(`Invalid timezone offset. ${INPUT_GUIDANCE}`);
	}
	const offset = (offsetHours * 60 + offsetMinutes) * 60_000 * (zone[0] === "+" ? 1 : -1);
	return new Date(wallTime.getTime() - offset).toISOString();
}

function localWallTimestamp(date: Date): number {
	const wallTime = new Date(0);
	wallTime.setUTCFullYear(date.getFullYear(), date.getMonth(), date.getDate());
	wallTime.setUTCHours(date.getHours(), date.getMinutes(), date.getSeconds(), date.getMilliseconds());
	return wallTime.getTime();
}

function resolveLocalTime(wallTimestamp: number): Date {
	const offsets = new Set<number>();
	// Read both sides of nearby transitions, including half-hour DST and date-line changes.
	for (const days of [-2, -1, 0, 1, 2]) {
		const probe = new Date(wallTimestamp + days * DAY_MS);
		offsets.add(localWallTimestamp(probe) - probe.getTime());
	}
	const candidates = [...offsets]
		.map((offset) => new Date(wallTimestamp - offset))
		.filter((candidate) => localWallTimestamp(candidate) === wallTimestamp);
	if (candidates.length === 0) {
		throw new Error(`This local time is nonexistent because the timezone clock moves forward. ${INPUT_GUIDANCE}`);
	}
	if (candidates.length !== 1) {
		throw new Error(`This local time is ambiguous because the timezone clock moves backward. ${INPUT_GUIDANCE}`);
	}
	return candidates[0];
}

function readAbsoluteTime(iso: string): Date {
	if (!/(Z|[+-]\d{2}:\d{2})$/.test(iso)) {
		throw new Error(`Expected an absolute reminder due time. ${INPUT_GUIDANCE}`);
	}
	return new Date(parseReminderDueAt(iso));
}

/** Display the stored instant in the current machine timezone, with its offset and zone name. */
export function formatReminderDueAt(iso: string): string {
	const date = readAbsoluteTime(iso);
	const formatter = new Intl.DateTimeFormat("en-CA", {
		year: "numeric",
		month: "2-digit",
		day: "2-digit",
		hour: "2-digit",
		minute: "2-digit",
		second: "2-digit",
		hourCycle: "h23",
		timeZoneName: "longOffset",
	});
	const parts = new Map(formatter.formatToParts(date).map((part) => [part.type, part.value]));
	const day = `${parts.get("year")}-${parts.get("month")}-${parts.get("day")}`;
	const clock = `${parts.get("hour")}:${parts.get("minute")}:${parts.get("second")}`;
	return `${day} ${clock} ${parts.get("timeZoneName")} [${formatter.resolvedOptions().timeZone}]`;
}

/** Include every overdue instant and the rest of the current local calendar day. */
export function isReminderDueToday(dueAt: string, now: Date): boolean {
	if (!Number.isFinite(now.getTime())) throw new Error("Invalid now date for reminder due-today comparison.");
	const dueTime = readAbsoluteTime(dueAt);
	const tomorrow = new Date(now.getTime());
	tomorrow.setHours(24, 0, 0, 0);
	return dueTime.getTime() < tomorrow.getTime();
}
