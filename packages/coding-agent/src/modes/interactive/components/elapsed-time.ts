const SECOND_MS = 1000;
export const MIN_VISIBLE_ELAPSED_MS = SECOND_MS;
const MINUTE_SECONDS = 60;
const HOUR_SECONDS = 60 * MINUTE_SECONDS;

function padTwoDigits(value: number): string {
	return value.toString().padStart(2, "0");
}

export function formatElapsedDuration(durationMs: number): string {
	const totalSeconds = Math.max(0, Math.floor(durationMs / SECOND_MS));
	if (totalSeconds < MINUTE_SECONDS) {
		return `${totalSeconds}s`;
	}

	const seconds = totalSeconds % MINUTE_SECONDS;
	const totalMinutes = Math.floor(totalSeconds / MINUTE_SECONDS);
	if (totalMinutes < MINUTE_SECONDS) {
		return `${totalMinutes}m ${padTwoDigits(seconds)}s`;
	}

	const hours = Math.floor(totalSeconds / HOUR_SECONDS);
	const minutes = totalMinutes % MINUTE_SECONDS;
	return `${hours}h ${padTwoDigits(minutes)}m`;
}
