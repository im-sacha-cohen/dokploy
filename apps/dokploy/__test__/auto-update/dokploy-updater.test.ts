import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
	base: "",
	rows: [] as Record<string, unknown>[],
	stale: [] as Record<string, unknown>[],
	updaterRunning: false,
}));

vi.mock("@dokploy/server/constants", async (importOriginal) => ({
	...(await importOriginal<object>()),
	paths: () => ({ BASE_PATH: state.base }),
}));

// One update_run table in memory. Lookups ignore the filter: each test holds
// at most the row of the run under test.
vi.mock("@dokploy/server/db", () => {
	const returning = (rows: Record<string, unknown>[]) => ({
		returning: () => Promise.resolve(rows),
	});
	return {
		db: {
			query: {
				updateRun: {
					findFirst: () => Promise.resolve(state.rows[0]),
					findMany: () => Promise.resolve(state.stale),
				},
			},
			insert: () => ({
				values: (values: Record<string, unknown>) => {
					const row = {
						updateRunId: `run-${state.rows.length + 1}`,
						finishedAt: null,
						...values,
					};
					state.rows.push(row);
					return returning([row]);
				},
			}),
			update: () => ({
				set: (values: Record<string, unknown>) => ({
					where: () => {
						const row = state.rows[0];
						if (row) Object.assign(row, values);
						// Awaited directly, or followed by .returning().
						return Object.assign(
							Promise.resolve(undefined),
							returning(row ? [row] : []),
						);
					},
				}),
			}),
		},
	};
});

vi.mock("@dokploy/server/utils/process/execAsync", () => ({
	execAsync: vi.fn(async () => ({
		stdout: state.updaterRunning ? "abc123\n" : "",
		stderr: "",
	})),
}));

const notify = vi.hoisted(() => vi.fn());
vi.mock("@dokploy/server/utils/notifications/auto-update", () => ({
	sendUpdateNotifications: notify,
}));

import {
	isDokployUpdateBusy,
	reconcileDokployUpdater,
	settleEarlierRuns,
} from "@dokploy/server/auto-update/dokploy-updater";

const writeState = (fields: Record<string, unknown>) =>
	writeFileSync(
		join(state.base, "updates", "state.json"),
		JSON.stringify({
			runId: "20261129T020000Z-abc",
			kind: "update",
			changed: true,
			fromImage: "ghcr.io/me/dokploy:smart-deploy@sha256:old",
			toImage: "ghcr.io/me/dokploy:smart-deploy@sha256:new",
			runDir: "/etc/dokploy/updates/runs/20261129T020000Z-abc",
			sourceRun: "",
			startedAt: "2026-11-29T02:00:00Z",
			updatedAt: "2026-11-29T02:09:00Z",
			message: "",
			...fields,
		}),
	);

const panelRow = (status: string) =>
	state.rows.push({
		updateRunId: "run-1",
		targetType: "dokploy",
		kind: "update",
		status,
		fromImage: "ghcr.io/me/dokploy:smart-deploy@sha256:old",
		toImage: "ghcr.io/me/dokploy:smart-deploy@sha256:new",
		updaterRunId: "20261129T020000Z-abc",
		startedAt: "2026-11-29T02:00:00Z",
		finishedAt: null,
	});

describe("reconcileDokployUpdater", () => {
	beforeEach(async () => {
		state.base = mkdtempSync(join(tmpdir(), "dokploy-updates-"));
		await mkdir(join(state.base, "updates"));
		state.rows = [];
		state.stale = [];
		state.updaterRunning = false;
		notify.mockClear();
	});
	afterEach(() => rmSync(state.base, { recursive: true, force: true }));

	it("does nothing before any updater ran", async () => {
		await expect(reconcileDokployUpdater()).resolves.toBe("idle");
		expect(state.rows).toEqual([]);
		await expect(isDokployUpdateBusy()).resolves.toBe(false);
	});

	it("records a put-back run found after the database restore, once", async () => {
		// The restored database holds the row as it was when the backup ran.
		panelRow("backing_up");
		writeState({
			status: "rolled_back",
			message:
				"The new version did not stay healthy. Everything was put back as before.",
		});
		await expect(reconcileDokployUpdater()).resolves.toBe("idle");
		expect(state.rows[0]).toMatchObject({
			status: "rolled_back",
			finishedAt: "2026-11-29T02:09:00Z",
			reason: expect.stringContaining("put back"),
		});
		expect(notify).toHaveBeenCalledTimes(1);
		expect(notify.mock.calls[0]?.[0]).toMatchObject({
			event: "dokployUpdate",
			outcome: "failure",
			title: expect.stringContaining("previous version runs again"),
		});
		await reconcileDokployUpdater();
		expect(notify).toHaveBeenCalledTimes(1);
	});

	it("follows a run while its updater works", async () => {
		panelRow("backing_up");
		writeState({ status: "verifying" });
		state.updaterRunning = true;
		await expect(reconcileDokployUpdater()).resolves.toBe("running");
		expect(state.rows[0]).toMatchObject({
			status: "verifying",
			finishedAt: null,
		});
		expect(notify).not.toHaveBeenCalled();
		await expect(isDokployUpdateBusy()).resolves.toBe(true);
	});

	it("marks a run interrupted when its updater is gone, and says so once", async () => {
		panelRow("updating");
		writeState({ status: "verifying" });
		await expect(reconcileDokployUpdater()).resolves.toBe("interrupted");
		expect(state.rows[0]).toMatchObject({
			status: "interrupted",
			reason: expect.stringContaining("Resume"),
		});
		expect(notify).toHaveBeenCalledTimes(1);
		await expect(reconcileDokployUpdater()).resolves.toBe("interrupted");
		expect(notify).toHaveBeenCalledTimes(1);
		// Still unfinished: nothing else may update until it is resumed.
		await expect(isDokployUpdateBusy()).resolves.toBe(true);
	});

	it("adds a row for a run started from the shell", async () => {
		writeState({ status: "succeeded", kind: "rollback" });
		await reconcileDokployUpdater();
		expect(state.rows).toHaveLength(1);
		expect(state.rows[0]).toMatchObject({
			targetType: "dokploy",
			kind: "rollback",
			status: "succeeded",
			updaterRunId: "20261129T020000Z-abc",
		});
		expect(notify.mock.calls[0]?.[0]).toMatchObject({
			title: "Dokploy rolled back",
			outcome: "success",
		});
	});
});

describe("settleEarlierRuns", () => {
	beforeEach(async () => {
		state.base = mkdtempSync(join(tmpdir(), "dokploy-updates-"));
		await mkdir(join(state.base, "updates", "runs", "20261129T020000Z-abc"), {
			recursive: true,
		});
		state.rows = [];
		state.stale = [];
	});
	afterEach(() => rmSync(state.base, { recursive: true, force: true }));

	it("finishes the half-written row of an update a go-back restored", async () => {
		// The database put back was saved while this update was backing up.
		panelRow("backing_up");
		state.stale = [state.rows[0] as Record<string, unknown>];
		writeFileSync(
			join(state.base, "updates", "runs", "20261129T020000Z-abc", "state.json"),
			JSON.stringify({
				runId: "20261129T020000Z-abc",
				kind: "update",
				status: "succeeded",
				fromImage: "ghcr.io/me/dokploy:smart-deploy@sha256:old",
				toImage: "ghcr.io/me/dokploy:smart-deploy@sha256:new",
				updatedAt: "2026-11-29T02:09:00Z",
				message: "",
			}),
		);
		await settleEarlierRuns("20261129T030000Z-rollback");
		expect(state.rows[0]).toMatchObject({
			status: "succeeded",
			finishedAt: "2026-11-29T02:09:00Z",
		});
	});

	it("leaves a row alone when its run folder has no final state", async () => {
		panelRow("backing_up");
		state.stale = [state.rows[0] as Record<string, unknown>];
		await settleEarlierRuns("20261129T030000Z-rollback");
		expect(state.rows[0]).toMatchObject({
			status: "backing_up",
			finishedAt: null,
		});
	});
});
