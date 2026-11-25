import { z } from "zod";

/**
 * Weekly maintenance window, in the wall-clock time of `timezone`. Days use
 * JavaScript numbering (0 = Sunday). Structured rather than a cron
 * expression so that two windows can be checked for overlap.
 */
export interface MaintenanceWindow {
	days: number[];
	startTime: string;
	durationMinutes: number;
	timezone: string;
}

export interface WindowOccurrence {
	start: Date;
	end: Date;
}

/** App updates stay this far from the Dokploy window, on both sides. */
export const DOKPLOY_UPDATE_MARGIN_MINUTES = 60;
const CONFLICT_HORIZON_WEEKS = 8;
const MINUTE = 60_000;
const DAY = 24 * 60 * MINUTE;

export const isValidTimezone = (timezone: string) => {
	try {
		new Intl.DateTimeFormat("en-US", { timeZone: timezone });
		return true;
	} catch {
		return false;
	}
};

export const maintenanceWindowSchema = z.object({
	days: z
		.array(z.number().int().min(0).max(6))
		.min(1)
		.refine((days) => new Set(days).size === days.length, "Days repeat"),
	startTime: z
		.string()
		.regex(/^([01]\d|2[0-3]):[0-5]\d$/, "Expected HH:MM, 24-hour"),
	durationMinutes: z.number().int().min(15).max(720),
	timezone: z.string().refine(isValidTimezone, "Unknown time zone"),
});

const formatters = new Map<string, Intl.DateTimeFormat>();
const formatterFor = (timeZone: string) => {
	let formatter = formatters.get(timeZone);
	if (!formatter) {
		formatter = new Intl.DateTimeFormat("en-US", {
			timeZone,
			hourCycle: "h23",
			year: "numeric",
			month: "2-digit",
			day: "2-digit",
			hour: "2-digit",
			minute: "2-digit",
			second: "2-digit",
		});
		formatters.set(timeZone, formatter);
	}
	return formatter;
};

const wallClockOf = (date: Date, timeZone: string) => {
	const parts = Object.fromEntries(
		formatterFor(timeZone)
			.formatToParts(date)
			.map((part) => [part.type, Number(part.value)]),
	);
	return Date.UTC(
		parts.year as number,
		(parts.month as number) - 1,
		parts.day,
		parts.hour,
		parts.minute,
		parts.second,
	);
};

const offsetAt = (instant: number, timeZone: string) =>
	wallClockOf(new Date(instant), timeZone) - Math.floor(instant / 1000) * 1000;

/**
 * The instant at which the clocks of `timeZone` show this wall-clock time.
 * A time skipped by a daylight-saving change lands just after the gap; a
 * time that happens twice resolves to one of the two.
 */
export const zonedTimeToUtc = (
	year: number,
	month: number,
	day: number,
	hour: number,
	minute: number,
	timeZone: string,
) => {
	const wall = Date.UTC(year, month - 1, day, hour, minute);
	let instant = wall - offsetAt(wall, timeZone);
	const offset = offsetAt(instant, timeZone);
	if (offset !== wall - instant) instant = wall - offset;
	return new Date(instant);
};

const parseStartTime = (startTime: string) => {
	const [hour = 0, minute = 0] = startTime.split(":").map(Number);
	return { hour, minute };
};

/** Occurrences that overlap [from, to), in order. */
export const windowOccurrences = (
	window: MaintenanceWindow,
	from: Date,
	to: Date,
): WindowOccurrence[] => {
	const { hour, minute } = parseStartTime(window.startTime);
	const days = new Set(window.days);
	// Starts a day early: an occurrence that began yesterday may still run.
	const first = wallClockOf(new Date(from.getTime() - DAY), window.timezone);
	const firstDay = new Date(first);
	const occurrences: WindowOccurrence[] = [];
	for (let i = 0; ; i++) {
		const date = new Date(
			Date.UTC(
				firstDay.getUTCFullYear(),
				firstDay.getUTCMonth(),
				firstDay.getUTCDate() + i,
			),
		);
		const start = zonedTimeToUtc(
			date.getUTCFullYear(),
			date.getUTCMonth() + 1,
			date.getUTCDate(),
			hour,
			minute,
			window.timezone,
		);
		if (start.getTime() >= to.getTime()) break;
		if (!days.has(date.getUTCDay())) continue;
		const end = new Date(start.getTime() + window.durationMinutes * MINUTE);
		if (end.getTime() > from.getTime()) occurrences.push({ start, end });
	}
	return occurrences;
};

/** The occurrence running at `now`, or the next one. */
export const currentOrNextOccurrence = (
	window: MaintenanceWindow,
	now: Date = new Date(),
) =>
	windowOccurrences(window, now, new Date(now.getTime() + 8 * DAY))[0] ?? null;

export interface WindowConflict {
	application: WindowOccurrence;
	dokploy: WindowOccurrence;
}

/**
 * App occurrences, over the next weeks, that come within the margin of a
 * Dokploy update window: an app updated then would be lost if the Dokploy
 * update failed and its database backup were restored.
 */
export const findWindowConflicts = (
	application: MaintenanceWindow,
	dokploy: MaintenanceWindow,
	{
		from = new Date(),
		weeks = CONFLICT_HORIZON_WEEKS,
		marginMinutes = DOKPLOY_UPDATE_MARGIN_MINUTES,
	}: { from?: Date; weeks?: number; marginMinutes?: number } = {},
): WindowConflict[] => {
	const to = new Date(from.getTime() + weeks * 7 * DAY);
	const margin = marginMinutes * MINUTE;
	const blocked = windowOccurrences(
		dokploy,
		new Date(from.getTime() - margin),
		new Date(to.getTime() + margin),
	);
	const conflicts: WindowConflict[] = [];
	for (const occurrence of windowOccurrences(application, from, to)) {
		const hit = blocked.find(
			(b) =>
				occurrence.start.getTime() < b.end.getTime() + margin &&
				b.start.getTime() - margin < occurrence.end.getTime(),
		);
		if (hit) conflicts.push({ application: occurrence, dokploy: hit });
	}
	return conflicts;
};

const formatMinutes = (minutes: number) =>
	`${String(Math.floor(minutes / 60)).padStart(2, "0")}:${String(minutes % 60).padStart(2, "0")}`;

/**
 * The closest later start time, on the same days and for the same length,
 * that does not conflict with the Dokploy window. Null when none exists.
 */
export const suggestFreeStartTime = (
	application: MaintenanceWindow,
	dokploy: MaintenanceWindow,
	options: { from?: Date; weeks?: number; marginMinutes?: number } = {},
) => {
	const { hour, minute } = parseStartTime(application.startTime);
	const original = hour * 60 + minute;
	for (let step = 30; step < 24 * 60; step += 30) {
		const startTime = formatMinutes((original + step) % (24 * 60));
		const candidate = { ...application, startTime };
		if (findWindowConflicts(candidate, dokploy, options).length === 0) {
			return startTime;
		}
	}
	return null;
};

export const formatOccurrence = (date: Date, timeZone: string) =>
	new Intl.DateTimeFormat("en-GB", {
		timeZone,
		weekday: "short",
		day: "numeric",
		month: "short",
		hour: "2-digit",
		minute: "2-digit",
		hourCycle: "h23",
	}).format(date);
