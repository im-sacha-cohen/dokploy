import {
	currentOrNextOccurrence,
	findWindowConflicts,
	type MaintenanceWindow,
	maintenanceWindowSchema,
	suggestFreeStartTime,
	windowOccurrences,
	zonedTimeToUtc,
} from "@dokploy/server/auto-update/window";
import { describe, expect, it } from "vitest";

const SUNDAY = 0;
const MONDAY = 1;
const SATURDAY = 6;
const paris = (
	days: number[],
	startTime: string,
	durationMinutes = 120,
): MaintenanceWindow => ({
	days,
	startTime,
	durationMinutes,
	timezone: "Europe/Paris",
});
// Wednesday 25 November 2026, 12:00 UTC.
const NOW = new Date("2026-11-25T12:00:00Z");
const iso = (d: Date) => d.toISOString();

describe("zonedTimeToUtc", () => {
	it("follows the time zone's offset in winter and summer", () => {
		expect(iso(zonedTimeToUtc(2026, 11, 29, 3, 0, "Europe/Paris"))).toBe(
			"2026-11-29T02:00:00.000Z",
		);
		expect(iso(zonedTimeToUtc(2026, 7, 5, 3, 0, "Europe/Paris"))).toBe(
			"2026-07-05T01:00:00.000Z",
		);
		expect(iso(zonedTimeToUtc(2026, 7, 5, 3, 0, "UTC"))).toBe(
			"2026-07-05T03:00:00.000Z",
		);
	});

	it("moves a time skipped by the spring change to just after the gap", () => {
		// 29 March 2026, Paris: 02:00 jumps to 03:00.
		expect(iso(zonedTimeToUtc(2026, 3, 29, 2, 30, "Europe/Paris"))).toBe(
			"2026-03-29T01:30:00.000Z",
		);
	});
});

describe("windowOccurrences", () => {
	it("lists the chosen days in local time, across the autumn change", () => {
		const occurrences = windowOccurrences(
			paris([SUNDAY], "03:00"),
			new Date("2026-10-17T00:00:00Z"),
			new Date("2026-11-01T00:00:00Z"),
		);
		expect(occurrences.map((o) => iso(o.start))).toEqual([
			"2026-10-18T01:00:00.000Z",
			"2026-10-25T02:00:00.000Z",
		]);
		expect(iso(occurrences[0]?.end as Date)).toBe("2026-10-18T03:00:00.000Z");
	});

	it("includes an occurrence that started before `from` and is still running", () => {
		const occurrences = windowOccurrences(
			paris([SUNDAY], "23:00", 180),
			new Date("2026-11-30T00:30:00Z"),
			new Date("2026-11-30T12:00:00Z"),
		);
		expect(occurrences.map((o) => iso(o.start))).toEqual([
			"2026-11-29T22:00:00.000Z",
		]);
	});

	it("gives the running or next occurrence", () => {
		expect(
			iso(
				currentOrNextOccurrence(paris([SUNDAY], "03:00"), NOW)?.start as Date,
			),
		).toBe("2026-11-29T02:00:00.000Z");
		const running = currentOrNextOccurrence(
			paris([SUNDAY], "03:00"),
			new Date("2026-11-29T02:30:00Z"),
		);
		expect(iso(running?.start as Date)).toBe("2026-11-29T02:00:00.000Z");
	});
});

describe("findWindowConflicts", () => {
	const dokploy = paris([SUNDAY], "03:00");

	it("finds an app window inside the Dokploy window", () => {
		const conflicts = findWindowConflicts(
			paris([SUNDAY], "04:00", 30),
			dokploy,
			{
				from: NOW,
			},
		);
		expect(conflicts).toHaveLength(8);
		expect(iso(conflicts[0]?.application.start as Date)).toBe(
			"2026-11-29T03:00:00.000Z",
		);
		expect(iso(conflicts[0]?.dokploy.start as Date)).toBe(
			"2026-11-29T02:00:00.000Z",
		);
	});

	it("keeps the margin after and before the Dokploy window", () => {
		// Dokploy runs 03:00-05:00; the margin blocks 02:00-06:00. Touching an
		// end of that range is allowed.
		expect(
			findWindowConflicts(paris([SUNDAY], "05:30", 30), dokploy, { from: NOW }),
		).toHaveLength(8);
		expect(
			findWindowConflicts(paris([SUNDAY], "01:45", 30), dokploy, { from: NOW }),
		).toHaveLength(8);
		expect(
			findWindowConflicts(paris([SUNDAY], "06:00", 30), dokploy, { from: NOW }),
		).toEqual([]);
		expect(
			findWindowConflicts(paris([SUNDAY], "01:00", 60), dokploy, { from: NOW }),
		).toEqual([]);
	});

	it("allows the same hours on other days", () => {
		expect(
			findWindowConflicts(paris([MONDAY, SATURDAY], "03:00"), dokploy, {
				from: NOW,
			}),
		).toEqual([]);
	});

	it("sees a conflict across midnight", () => {
		const lateDokploy = paris([SATURDAY], "23:00");
		const conflicts = findWindowConflicts(
			paris([SUNDAY], "00:30", 30),
			lateDokploy,
			{ from: NOW },
		);
		expect(conflicts.length).toBeGreaterThan(0);
	});

	it("compares windows set in different time zones", () => {
		// 03:00 in Paris is 02:00 UTC in winter.
		const utcApp: MaintenanceWindow = {
			days: [SUNDAY],
			startTime: "02:30",
			durationMinutes: 30,
			timezone: "UTC",
		};
		expect(findWindowConflicts(utcApp, dokploy, { from: NOW })).toHaveLength(8);
		const tokyoApp: MaintenanceWindow = {
			days: [SUNDAY],
			startTime: "11:00",
			durationMinutes: 30,
			timezone: "Asia/Tokyo",
		};
		// 11:00 in Tokyo is 02:00 UTC, 03:00 in Paris.
		expect(findWindowConflicts(tokyoApp, dokploy, { from: NOW })).toHaveLength(
			8,
		);
	});

	it("follows the summer change: a conflict in winter only", () => {
		// 01:00 UTC is 02:00 in Paris in winter (inside the margin) and 03:00 in
		// summer (inside the window): both conflict. 05:00 UTC is 06:00 in winter
		// (free) and 07:00 in summer (free).
		const from = new Date("2027-03-10T00:00:00Z");
		const at = (startTime: string): MaintenanceWindow => ({
			days: [SUNDAY],
			startTime,
			durationMinutes: 30,
			timezone: "UTC",
		});
		expect(findWindowConflicts(at("05:00"), dokploy, { from })).toEqual([]);
		// 04:30 UTC is 05:30 in winter (margin) and 06:30 in summer (free).
		const conflicts = findWindowConflicts(at("04:30"), dokploy, {
			from,
			weeks: 4,
		});
		expect(conflicts.map((c) => iso(c.application.start))).toEqual([
			"2027-03-14T04:30:00.000Z",
			"2027-03-21T04:30:00.000Z",
		]);
	});
});

describe("suggestFreeStartTime", () => {
	it("proposes the closest later free start", () => {
		expect(
			suggestFreeStartTime(
				paris([SUNDAY], "04:00", 30),
				paris([SUNDAY], "03:00"),
				{
					from: NOW,
				},
			),
		).toBe("06:00");
	});

	it("returns null when every day is taken", () => {
		const halfDay = paris([0, 1, 2, 3, 4, 5, 6], "00:00", 720);
		expect(
			suggestFreeStartTime(paris([SUNDAY], "04:00", 30), halfDay, {
				from: NOW,
				marginMinutes: 0,
			}),
		).toBe("12:00");
		// 12 hours plus 6 hours of margin on each side cover the whole day.
		expect(
			suggestFreeStartTime(paris([SUNDAY], "04:00", 30), halfDay, {
				from: NOW,
				marginMinutes: 360,
			}),
		).toBeNull();
	});
});

describe("maintenanceWindowSchema", () => {
	it("accepts a valid window", () => {
		expect(
			maintenanceWindowSchema.safeParse(paris([SUNDAY], "03:00")).success,
		).toBe(true);
	});

	it.each([
		["no day", { ...paris([], "03:00") }],
		["repeated day", { ...paris([0, 0], "03:00") }],
		["day out of range", { ...paris([7], "03:00") }],
		["bad time", { ...paris([0], "3:00") }],
		["hour 24", { ...paris([0], "24:00") }],
		["too short", { ...paris([0], "03:00", 10) }],
		["too long", { ...paris([0], "03:00", 721) }],
		["unknown time zone", { ...paris([0], "03:00"), timezone: "Mars/Olympus" }],
	])("refuses %s", (_, window) => {
		expect(maintenanceWindowSchema.safeParse(window).success).toBe(false);
	});
});
